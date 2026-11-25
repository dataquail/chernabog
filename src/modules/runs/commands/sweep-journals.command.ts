import { Command } from "@effect-server-utils/cqrs";

import { SweptJournals } from "../domain/run/run-view.value-object.ts";

// Deletes the journals of runs that have ended, which a crash kept the
// RunFinished reaction from deleting (discard-run-journal). It resumes nothing
// from a journal and executes no run (ADR 23, decision 3): a run a restart
// left running is the hub's reap to end, and its phase repeats in a new run.
export const SweepJournalsCommand = Command.make("SweepJournalsCommand", {
  success: SweptJournals,
});
