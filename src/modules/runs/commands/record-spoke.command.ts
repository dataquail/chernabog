import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// Records the spoke the hub has just spawned for a run (ADR 23, decision 7):
// its PID, which is also its process group's, and when the OS says it
// started, and the hub's own, so a hub that starts after this one died can
// end it, and tell it from a process that reuses its PID. Nothing folded
// yet, and no ending meant for it.
export const RecordSpokeCommand = Command.make("RecordSpokeCommand", {
  payload: {
    runId: RunId,
    pid: Schema.Finite,
    startedAt: Schema.Option(Schema.String),
    hubPid: Schema.Finite,
    hubStartedAt: Schema.Option(Schema.String),
  },
});

export type RecordSpokePayload = Command.Payload<typeof RecordSpokeCommand>;
