import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { type RunMarkerRoot } from "../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { MarkerReleases, RunMarkerView } from "./run-marker.result.ts";

// The run a release is asked about, as the flow's check would be: by its
// item, or one made from its key for a run that kept none.
const questionOf = (run: RunRoot) => ({
  runId: run.id,
  executionId: Option.getOrElse(run.executionId, () => ""),
  item: Option.getOrElse(run.item, () => ({ key: run.itemKey, data: {} })),
  subjects: run.subjects,
});

// Releases what ended runs still hold, as each run's persona, through its
// flow as this process loaded it (the base branch's): each run's markers
// newest first, keeping those whose keepOn names the run's ending. A release
// that fails stays held, to try again after a backoff; one the flow no
// longer defines is unreleasable, for a person. A run in flight keeps its
// markers, and a release not yet due waits. Safe to repeat: a release that
// ran before a crash runs again.
export const releaseMarkersUseCase = Effect.fn("releaseMarkersUseCase")(function* () {
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

  const held = yield* markers.findAll({ runId: Option.none(), status: Option.some("held") });
  const byRun = Arr.groupBy(held, (marker) => marker.runId);

  for (const ownMarkers of Object.values(byRun)) {
    const ended = Option.filter(
      yield* runs.findOne(ownMarkers[0].runId),
      (run) => !RunRootOps.isRunning(run),
    );

    if (Option.isNone(ended)) {
      continue;
    }

    const run = ended.value;
    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    for (const marker of RunMarkerRootOps.releaseOrder(ownMarkers)) {
      if (!RunMarkerRootOps.isDue(marker, now)) {
        continue;
      }

      if (RunMarkerRootOps.keptOn(marker, run.status)) {
        const stays = RunMarkerRootOps.kept(marker, at);
        yield* markers.save(stays);
        kept.push(stays);
        continue;
      }

      const release = yield* flows
        .releaseMarker(flow, questionOf(run), marker.name, marker.args)
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

      yield* markers.save(settled);
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
