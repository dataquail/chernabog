import * as Effect from "effect/Effect";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { ExecutionOutcome, type PollExecutionPayload } from "./poll-execution.query.ts";

export const pollExecutionHandler = Effect.fn("pollExecutionHandler")(function* ({
  executionId,
  flow,
}: PollExecutionPayload) {
  return ExecutionOutcome.make({ ended: yield* (yield* WorkflowsClient).poll(flow, executionId) });
});
