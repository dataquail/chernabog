import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogMissing, RunLogPruned } from "../domain/run/run.errors.ts";

// A run's log as it is now, and where it's kept.
export class RunLog extends Schema.Class<RunLog, { readonly brand: "RunLog" }>("RunLog")({
  runId: RunId,
  path: Schema.String,
  text: Schema.String,
}) {}

// A run's log as it is now. Fails when the run has written none, or when a
// prune removed it, past its retention.
export const ReadRunLogQuery = Query.make("ReadRunLogQuery", {
  payload: { runId: RunId },
  success: RunLog,
  failure: Schema.Union([RunLogMissing, RunLogPruned]),
});

export type ReadRunLogPayload = Query.Payload<typeof ReadRunLogQuery>;
