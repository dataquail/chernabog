import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";
import { type HoldMarkerPayload } from "./hold-marker.command.ts";

export const holdMarkerHandler = Effect.fn("holdMarkerHandler")(function* (
  holding: HoldMarkerPayload,
) {
  const markers = yield* RunMarkersRepository;

  const existing = Option.fromUndefinedOr(
    (yield* markers.findAll({ runId: Option.some(holding.runId), status: Option.none() })).find(
      (marker) => RunMarkerRootOps.same(marker, holding),
    ),
  );

  const held = RunMarkerRootOps.holdAgain(
    existing,
    holding,
    DateTime.formatIso(yield* DateTime.now),
  );

  for (const marker of Option.toArray(held)) {
    yield* markers.save(marker);
  }

  return RunMarkerView.make({ ...Option.getOrThrow(Option.orElse(held, () => existing)) });
});
