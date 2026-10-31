import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { Spec } from "../../../kernel/specification.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { type RunFinished } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunMarkerEvents } from "../domain/run-marker/run-marker.events.ts";
import { type RunMarkerRoot } from "../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import {
  MarkerReleases,
  RunMarkerView,
} from "../domain/run-marker/run-marker-view.value-object.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";

// The unit of work around each of this reaction's writes in state.db alone.
// Releasing a marker runs the flow's release, which reaches GitHub, so it stays
// outside one (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

// Releases the markers a run held, the moment it ends, however it ended: newest
// first, keeping those its ending's keepOn names. A release that fails stays
// held, backing off, for ReleaseMarkersCommand's sweep to try again; so does
// one a crash kept this reaction from running. A repeat of the event finds
// nothing held, and releases nothing twice. It says what it did
// (RunMarkersReleased), for the daemon to log.
export const releaseRunMarkersHandler = Effect.fn("releaseRunMarkersHandler")(function* (
  event: RunFinished,
) {
  const markers = yield* RunMarkersRepository;
  const runs = yield* RunsRepository;
  const flows = yield* FlowsClient;

  const ended = Option.filter(
    yield* runs.findOne(RunSpecifications.withId(event.runId)),
    (run) => !RunRootOps.isRunning(run),
  );

  for (const run of Option.toArray(ended)) {
    const held = yield* markers.findMany(
      Spec.and(RunMarkerSpecifications.forRun(run.id), RunMarkerSpecifications.inStatus("held")),
    );

    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    // The run a release is asked about, as the flow's check would be.
    const question = {
      runId: run.id,
      executionId: Option.getOrElse(run.executionId, () => ""),
      item: Option.getOrElse(run.item, () => ({ key: run.itemKey, data: {} })),
      subjects: run.subjects,
    };

    const released: Array<RunMarkerRoot> = [];
    const kept: Array<RunMarkerRoot> = [];
    const failed: Array<RunMarkerRoot> = [];
    const unreleasable: Array<RunMarkerRoot> = [];

    for (const marker of RunMarkerRootOps.releaseOrder(held)) {
      const now = yield* DateTime.now;
      const at = DateTime.formatIso(now);

      // One tried before is the sweep's, even for a repeat of the event: the
      // two never release one marker at once.
      if (!RunMarkerRootOps.untried(marker)) {
        continue;
      }

      if (RunMarkerRootOps.keptOn(marker, run.status)) {
        const stays = RunMarkerRootOps.kept(marker, at);
        yield* markers.upsertOne(stays).pipe(inUnitOfWork);
        kept.push(stays);
        continue;
      }

      const release = yield* flows
        .releaseMarker(flow, question, marker.name, marker.args)
        .pipe(Effect.result);

      const settled = Result.match(release, {
        onSuccess: () => RunMarkerRootOps.released(marker, at),
        onFailure: (error) => {
          if (Predicate.isTagged(error, "MarkerUnreleasable")) {
            return RunMarkerRootOps.unreleasable(marker, error.message, at);
          }

          return RunMarkerRootOps.failed(marker, error.message, now);
        },
      });

      yield* markers.upsertOne(settled).pipe(inUnitOfWork);

      if (settled.status === "released") {
        released.push(settled);
      } else if (settled.status === "unreleasable") {
        unreleasable.push(settled);
      } else {
        failed.push(settled);
      }
    }

    const views = (found: ReadonlyArray<RunMarkerRoot>) =>
      found.map((marker) => RunMarkerView.make({ ...marker }));

    // What it did, for the daemon to log: once, since a repeat settles nothing.
    const said = RunMarkerEvents.released(
      run.id,
      MarkerReleases.make({
        released: views(released),
        kept: views(kept),
        failed: views(failed),
        unreleasable: views(unreleasable),
      }),
    );

    yield* EventBus.use((bus) => bus.dispatch(Option.toArray(said))).pipe(inUnitOfWork);
  }
});
