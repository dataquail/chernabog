import { Event } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// An agent call of a run recorded what it spent, once its rows (and its
// session's cursor, when its adapter reported) were written: the run's totals
// have changed. It carries no counts; a consumer asks for them.
export const TokenUsageRecorded = Event.make("TokenUsageRecorded", {
  eventId: Schema.String,
  runId: RunId,
  step: Schema.Option(Schema.String),
  adapter: Schema.String,
  sessionId: Schema.String,
  reported: Schema.Boolean,
  recordedAt: Schema.String,
});

export type TokenUsageRecorded = typeof TokenUsageRecorded.Type;
