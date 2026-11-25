import * as Effect from "effect/Effect";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { type RunFinished } from "../domain/run/run.events.ts";

// Deletes a run's journal the moment it ends, however it ended, cancel
// included (ADR 23, decision 3): its execution is interrupted and its engine
// closed first, so nothing writes the file once it's gone. A repeat of the
// event finds no journal and deletes nothing; a journal a crash kept this
// reaction from deleting is RecoverRunsCommand's to sweep.
export const discardRunJournalHandler = Effect.fn("discardRunJournalHandler")(function* (
  event: RunFinished,
) {
  yield* (yield* WorkflowsClient).discard(event.runId);
});
