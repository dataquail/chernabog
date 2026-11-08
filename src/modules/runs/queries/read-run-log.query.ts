import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { NodeRef } from "../domain/plan/node-ref.value-object.ts";
import { RunLogMissing, RunLogPruned } from "../domain/run/run.errors.ts";

// A run's log as it is now, as a person reads it (without the steps its
// lines are tagged with), and where it's kept.
export class RunLog extends Schema.Class<RunLog, { readonly brand: "RunLog" }>("RunLog")({
  runId: RunId,
  path: Schema.String,
  text: Schema.String,
}) {}

// An engine step where in its plan a run ran it, as its history keeps it
// (RunStep): the step by its full name, and its node, none for a step at no
// node, such as one of set up or wrap up.
export const LoggedAt = Schema.Struct({ step: Schema.String, node: Schema.optionalKey(NodeRef) });

export type LoggedAt = typeof LoggedAt.Type;

// A run's log as it is now; with `only`, just the lines those steps wrote at
// those nodes, as a node of a run's plan shows its log. Fails when the run has written none, or when a
// prune removed it, past its retention.
export const ReadRunLogQuery = Query.make("ReadRunLogQuery", {
  payload: { runId: RunId, only: Schema.optionalKey(Schema.Array(LoggedAt)) },
  success: RunLog,
  failure: Schema.Union([RunLogMissing, RunLogPruned]),
});

export type ReadRunLogPayload = Query.Payload<typeof ReadRunLogQuery>;
