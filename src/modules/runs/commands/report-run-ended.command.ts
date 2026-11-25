import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { SpokeEnding } from "../domain/run/spoke-ending.value-object.ts";

// A spoke's last report (ADR 23, decision 2): how its run ended, written
// into the run's own journal, never state.db. The hub ends the run with it
// once the spoke has exited.
export const ReportRunEndedCommand = Command.make("ReportRunEndedCommand", {
  payload: { runId: RunId, ending: SpokeEnding },
});

export type ReportRunEndedPayload = Command.Payload<typeof ReportRunEndedCommand>;
