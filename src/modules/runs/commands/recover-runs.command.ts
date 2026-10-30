import { Command } from "@effect-server-utils/cqrs";

import { RecoveredRuns } from "../domain/run/run-view.value-object.ts";

// Finishes the starts a crash interrupted. A run is recorded before its
// workflow executes, so a process killed in between leaves one running with no
// execution, which nothing polls and which holds its item. Its workflow
// executes now from the work item the run kept: an execution is keyed by its
// run, so one that did start before the crash is the one attached, not a
// second. A run with no item to execute ends, so its item can start again. A
// run whose flow this process didn't load is left for one that has.
export const RecoverRunsCommand = Command.make("RecoverRunsCommand", {
  success: RecoveredRuns,
});
