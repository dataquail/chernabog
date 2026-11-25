import * as Effect from "effect/Effect";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { type ReadSpokeEndingPayload, SpokeEndingRead } from "./read-spoke-ending.query.ts";

export const readSpokeEndingHandler = Effect.fn("readSpokeEndingHandler")(function* ({
  runId,
}: ReadSpokeEndingPayload) {
  return SpokeEndingRead.make({ ending: yield* (yield* WorkflowsClient).reportedEnding(runId) });
});
