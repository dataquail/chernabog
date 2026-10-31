import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Spec } from "../../../kernel/specification.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import { RunMarkers, RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";
import { type ListRunMarkersPayload } from "./list-run-markers.query.ts";

export const listRunMarkersHandler = Effect.fn("listRunMarkersHandler")(function* ({
  name,
  runId,
}: ListRunMarkersPayload) {
  const held = yield* (yield* RunMarkersRepository).findMany(
    Spec.and(RunMarkerSpecifications.forRun(runId), RunMarkerSpecifications.inStatus("held")),
  );

  return RunMarkers.make({
    markers: held
      .filter((marker) =>
        Option.match(name, { onNone: () => true, onSome: (named) => marker.name === named }),
      )
      .map((marker) => RunMarkerView.make({ ...marker })),
  });
});
