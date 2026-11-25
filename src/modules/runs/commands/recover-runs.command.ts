import { Command } from "@effect-server-utils/cqrs";

import { RecoveredRuns } from "../domain/run/run-view.value-object.ts";

// Finishes the starts a crash interrupted. A run is recorded before its
// workflow executes, so a process killed in between leaves one running with no
// execution, which nothing polls and which holds its item. Its workflow
// executes now from the work item the run kept: an execution is keyed by its
// run, so one that did start before the crash is the one attached, not a
// second. A run with no item to execute ends, so its item can start again. A
// run whose flow this process didn't load is left for one that has.
//
// It also deletes the journals of runs that have ended, which a crash kept
// the RunFinished reaction from deleting (discard-run-journal). And, until
// reaping (#664) ends a restart's runs and the in-process path goes (#665),
// it resumes each running run of a flow this process loaded from its journal,
// or, with its journal gone (as for a run journaled in state.db before
// journals were per run), executes it again from its item.
export const RecoverRunsCommand = Command.make("RecoverRunsCommand", {
  success: RecoveredRuns,
});
