import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunMarkers, RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";
import { type ListRunMarkersPayload } from "./list-run-markers.query.ts";

export const listRunMarkersHandler = Effect.fn("listRunMarkersHandler")(function* ({
  name,
  runId,
}: ListRunMarkersPayload) {
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
