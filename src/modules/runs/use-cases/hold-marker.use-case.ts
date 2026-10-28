import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { type Holding, RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerView } from "./run-marker.result.ts";

// Records that a run holds a marker, for its release when the run ends. A
// run holds a name and arguments once, so a run that resumes and holds it
// again changes nothing; one it let go is held again.
export const holdMarkerUseCase = Effect.fn("holdMarkerUseCase")(function* (holding: Holding) {
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
