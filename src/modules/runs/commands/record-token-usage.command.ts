import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { TokenUsageReading } from "../domain/token-usage/model-usage.value-object.ts";

// An agent call of a run ended, and here is what it spent: its adapter's
// reading of the session since the session's cursor, or none when the
// adapter couldn't say (it has no reader, or its reader failed). A reading
// writes a row per model and moves the session's cursor to the reading's; no
// reading writes one row that says so and leaves the cursor where it was.
export const RecordTokenUsageCommand = Command.make("RecordTokenUsageCommand", {
  payload: {
    runId: RunId,
    step: Schema.Option(Schema.String),
    adapter: Schema.String,
    sessionId: Schema.String,
    reading: Schema.Option(TokenUsageReading),
  },
});

export type RecordTokenUsagePayload = Command.Payload<typeof RecordTokenUsageCommand>;
