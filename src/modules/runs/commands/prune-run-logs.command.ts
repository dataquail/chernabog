import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// The run logs a prune removed.
export class PrunedRunLogs extends Schema.Class<PrunedRunLogs, { readonly brand: "PrunedRunLogs" }>(
  "PrunedRunLogs",
)({ removed: Schema.Array(RunId) }) {}

// Removes the run logs past their retention (RunLogRetention): a run's once
// it finished more than 30 days ago, as state.db says, never one still
// running, parked or needing attention; and one no run in state.db has once
// it hasn't been written for 30 days. Each leaves a note behind, so `logs`
// says the log was removed rather than that there's no such run.
export const PruneRunLogsCommand = Command.make("PruneRunLogsCommand", {
  success: PrunedRunLogs,
});
