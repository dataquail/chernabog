import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunMarkers, RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";

export const listUnreleasedMarkersHandler = Effect.fn("listUnreleasedMarkersHandler")(function* () {
  const markers = yield* RunMarkersRepository;
  const runs = yield* RunsRepository;
  const unreleased: Array<RunMarkerView> = [];
  const held = yield* markers.findAll({ runId: Option.none(), status: Option.some("held") });

  const unreleasable = yield* markers.findAll({
    runId: Option.none(),
    status: Option.some("unreleasable"),
  });

  for (const marker of held) {
    const run = yield* runs.findOne(marker.runId);

    if (!Option.exists(run, RunRootOps.isRunning)) {
      unreleased.push(RunMarkerView.make({ ...marker }));
    }
  }

  return RunMarkers.make({
    markers: [...unreleased, ...unreleasable.map((marker) => RunMarkerView.make({ ...marker }))],
  });
});
