import * as Schema from "effect/Schema";

// What one model spent in one agent call, as the adapter that drove it read
// it from its own records: raw token counts, never dollars. A count the
// adapter's agent doesn't report is none, not zero.
export const ModelUsage = Schema.Struct({
  model: Schema.String,
  input: Schema.Option(Schema.Finite),
  output: Schema.Option(Schema.Finite),
  cacheRead: Schema.Option(Schema.Finite),
  cacheWrite: Schema.Option(Schema.Finite),
});

export type ModelUsage = typeof ModelUsage.Type;

// What an adapter read of a session since its cursor: each model's usage, and
// the cursor to read on from next time, which only that adapter understands.
export const TokenUsageReading = Schema.Struct({
  records: Schema.Array(ModelUsage),
  cursor: Schema.String,
});

export type TokenUsageReading = typeof TokenUsageReading.Type;
