import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type RunMarkerRoot } from "../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import {
  MarkerReleases,
  RunMarkerView,
} from "../domain/run-marker/run-marker-view.value-object.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the engine's journal
// waits on (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

export const releaseMarkersHandler = Effect.fn("releaseMarkersHandler")(function* () {
  const markers = yield* RunMarkersRepository;
  const runs = yield* RunsRepository;
  const flows = yield* FlowsClient;
  const now = yield* DateTime.now;
  const at = DateTime.formatIso(now);

  const released: Array<RunMarkerRoot> = [];
  const kept: Array<RunMarkerRoot> = [];
  const failed: Array<RunMarkerRoot> = [];
  const unreleasable: Array<RunMarkerRoot> = [];

  // Where a release's outcome is reported: still held is a failure.
  const sortedBy = (settled: RunMarkerRoot) => {
    if (settled.status === "released") {
      return released;
    }

    if (settled.status === "unreleasable") {
      return unreleasable;
    }

    return failed;
  };

  const held = yield* markers.findMany(RunMarkerSpecifications.inStatus("held"));
  const byRun = Arr.groupBy(held, (marker) => marker.runId);

  for (const ownMarkers of Object.values(byRun)) {
    const ended = Option.filter(
      yield* runs.findOne(RunSpecifications.withId(ownMarkers[0].runId)),
      (run) => !RunRootOps.isRunning(run),
    );

    if (Option.isNone(ended)) {
      continue;
    }

    const run = ended.value;
    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    for (const marker of RunMarkerRootOps.releaseOrder(ownMarkers)) {
      // A marker its run's ending is still releasing is left to it.
      if (
        !RunMarkerRootOps.isDue(marker, now) ||
        !RunMarkerRootOps.leftToSweep(marker, run.finishedAt, now)
      ) {
        continue;
      }

      if (RunMarkerRootOps.keptOn(marker, run.status)) {
        const stays = RunMarkerRootOps.kept(marker, at);
        yield* markers.upsertOne(stays).pipe(inUnitOfWork);
        kept.push(stays);
        continue;
      }

      const release = yield* flows
        .releaseMarker(flow, RunRootOps.questionOf(run), marker.name, marker.args)
        .pipe(Effect.result);

      const settled = RunMarkerRootOps.afterRelease(marker, release, now);

      yield* markers.upsertOne(settled).pipe(inUnitOfWork);
      sortedBy(settled).push(settled);
    }
  }

  const views = (found: ReadonlyArray<RunMarkerRoot>) =>
    found.map((marker) => RunMarkerView.make({ ...marker }));

  return MarkerReleases.make({
    released: views(released),
    kept: views(kept),
    failed: views(failed),
    unreleasable: views(unreleasable),
  });
});
