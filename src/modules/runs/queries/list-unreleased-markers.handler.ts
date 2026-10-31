import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import { RunMarkers, RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";

export const listUnreleasedMarkersHandler = Effect.fn("listUnreleasedMarkersHandler")(function* () {
  const markers = yield* RunMarkersRepository;
  const runs = yield* RunsRepository;
  const unreleased: Array<RunMarkerView> = [];
  const held = yield* markers.findMany(RunMarkerSpecifications.inStatus("held"));

  const unreleasable = yield* markers.findMany(RunMarkerSpecifications.inStatus("unreleasable"));

  for (const marker of held) {
    const run = yield* runs.findOne(RunSpecifications.withId(marker.runId));

    if (!Option.exists(run, RunRootOps.isRunning)) {
      unreleased.push(RunMarkerView.make({ ...marker }));
    }
  }

  return RunMarkers.make({
    markers: [...unreleased, ...unreleasable.map((marker) => RunMarkerView.make({ ...marker }))],
  });
});
