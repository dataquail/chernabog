import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { type Holding, RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";

// Forgets a hold a run let go of itself (Markers.drop), so nothing releases
// it when the run ends. Forgetting one it doesn't hold changes nothing.
export const forgetMarkerUseCase = Effect.fn("forgetMarkerUseCase")(function* (
  holding: Omit<Holding, "keepOn">,
) {
  const markers = yield* RunMarkersRepository;

  const held = (yield* markers.findAll({
    runId: Option.some(holding.runId),
    status: Option.none(),
  })).filter((marker) => RunMarkerRootOps.same(marker, { ...holding, keepOn: [] }));

  for (const marker of held) {
    yield* markers.remove(marker);
  }
});
