import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { SpokeEndRequest } from "../domain/run-spoke/spoke-end-request.value-object.ts";

// Records the ending the hub means for a run whose spoke it is about to end
// (ADR 23, decisions 4 to 6): a cancel, a lost lease, a bound. The first one
// recorded holds. A hub that dies before the run has ended finishes it with
// this ending when it restarts, rather than as interrupted (decision 7).
// Nothing for a run whose spoke has no record.
export const IntendSpokeEndingCommand = Command.make("IntendSpokeEndingCommand", {
  payload: { runId: RunId, ending: SpokeEndRequest },
});

export type IntendSpokeEndingPayload = Command.Payload<typeof IntendSpokeEndingCommand>;
