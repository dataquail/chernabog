import * as Effect from "effect/Effect";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { type RunFinished } from "../domain/run/run.events.ts";

// Releases the markers a run held, the moment it ends: not yet.
export const releaseRunMarkersHandler = Effect.fn("releaseRunMarkersHandler")(function* (
  event: RunFinished,
) {
  yield* Effect.succeed<RunId>(event.runId);
});
