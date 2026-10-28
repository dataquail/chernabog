import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunMarkers, RunMarkerView } from "./run-marker.result.ts";

// The markers a run still holds, in the order it held them; with a name, only those of it.
export const listRunMarkersUseCase = Effect.fn("listRunMarkersUseCase")(function* (
  runId: RunId,
  name: Option.Option<string>,
) {
  const held = yield* (yield* RunMarkersRepository).findAll({
    runId: Option.some(runId),
    status: Option.some("held"),
  });

  return RunMarkers.make({
    markers: held
      .filter((marker) =>
        Option.match(name, { onNone: () => true, onSome: (named) => marker.name === named }),
      )
      .map((marker) => RunMarkerView.make({ ...marker })),
  });
});
