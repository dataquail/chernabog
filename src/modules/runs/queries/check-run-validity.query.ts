import { Query } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunValidity } from "../domain/schedule/validity.value-object.ts";

// Asks a run's flow whether its work item is still valid, as the run's
// persona, about the run, the item it kept and the pull request it opened.
// A run that has ended, kept no item or has no execution yet, or whose flow
// has no stillValid, isn't checked; a check that fails is CheckFailed, never
// Gone. Ending a gone run is the caller's, through CancelRunCommand.
export const CheckRunValidityQuery = Query.make("CheckRunValidityQuery", {
  payload: { runId: RunId },
  success: RunValidity,
});

export type CheckRunValidityPayload = Query.Payload<typeof CheckRunValidityQuery>;
