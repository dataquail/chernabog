import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// A run's write created an issue on its repo (Capabilities.Write's
// `creates`), which the run's journal keeps for what cleans up after it, such
// as a rehearsal. An issue recorded again changes nothing.
export const RecordCreatedIssueCommand = Command.make("RecordCreatedIssueCommand", {
  payload: { runId: RunId, issue: Schema.Finite },
});

export type RecordCreatedIssuePayload = Command.Payload<typeof RecordCreatedIssueCommand>;
