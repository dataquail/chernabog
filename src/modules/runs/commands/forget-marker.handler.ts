import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { type ForgetMarkerPayload } from "./forget-marker.command.ts";

export const forgetMarkerHandler = Effect.fn("forgetMarkerHandler")(function* ({
  args,
  name,
  runId,
}: ForgetMarkerPayload) {
  const markers = yield* RunMarkersRepository;

  const held = (yield* markers.findAll({
    runId: Option.some(runId),
    status: Option.none(),
  })).filter((marker) => RunMarkerRootOps.same(marker, { runId, name, args, keepOn: [] }));

  for (const marker of held) {
    yield* markers.remove(marker);
  }
});
