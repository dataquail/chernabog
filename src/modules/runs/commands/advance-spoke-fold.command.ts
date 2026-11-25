import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// Moves a spoke's fold position past the report at `seq` (ADR 23, decision
// 3). The hub dispatches it in the same unit of work as that report's
// command, so the report and the position past it commit together, and a hub
// that dies between folds folds each report once. Nothing for a run whose
// spoke has no record, such as one whose run has ended.
export const AdvanceSpokeFoldCommand = Command.make("AdvanceSpokeFoldCommand", {
  payload: { runId: RunId, seq: Schema.Finite },
});

export type AdvanceSpokeFoldPayload = Command.Payload<typeof AdvanceSpokeFoldCommand>;
