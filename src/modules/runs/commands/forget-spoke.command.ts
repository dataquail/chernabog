import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";

// Forgets a run's spoke once its run has ended (ADR 23, decision 7): no hub
// will end it again. Nothing for a run whose spoke has no record.
export const ForgetSpokeCommand = Command.make("ForgetSpokeCommand", {
  payload: { runId: RunId },
});

export type ForgetSpokePayload = Command.Payload<typeof ForgetSpokeCommand>;
