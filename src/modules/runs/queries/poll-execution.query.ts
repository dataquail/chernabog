import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// How a run's workflow ended, if it has: what a spoke follows its run by,
// without ending the run in state.db, which the hub does (ADR 23, decision 2).
export class ExecutionOutcome extends Schema.Class<
  ExecutionOutcome,
  { readonly brand: "ExecutionOutcome" }
>("ExecutionOutcome")({
  ended: Schema.Option(
    Schema.Struct({
      status: Schema.Literals(["done", "skipped", "needs-human", "failed", "lost"]),
      summary: Schema.String,
    }),
  ),
}) {}

// Polls a workflow this process executes, by its execution (the one the hub
// attached to its run): none while it runs, or for a flow this process
// didn't load.
export const PollExecutionQuery = Query.make("PollExecutionQuery", {
  payload: {
    runId: RunId,
    executionId: Schema.String,
    flow: Schema.Struct({
      repo: Schema.String,
      flow: Schema.String,
      persona: Schema.Option(Schema.String),
    }),
  },
  success: ExecutionOutcome,
});

export type PollExecutionPayload = Query.Payload<typeof PollExecutionQuery>;
