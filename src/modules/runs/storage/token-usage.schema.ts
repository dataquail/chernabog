// A row of om_agent_usage, in state.db: what one agent call of a run spent on
// one model, or a call whose adapter couldn't say. The token-usage repository
// writes it and the runs queries read it, so its shape is named once, here;
// turning one into a root stays the repository's mapper's.

import * as Schema from "effect/Schema";

export const TokenUsageRow = Schema.Struct({
  run_id: Schema.String,
  step: Schema.NullOr(Schema.String),
  adapter: Schema.String,
  session_id: Schema.String,
  model: Schema.NullOr(Schema.String),
  input: Schema.NullOr(Schema.Finite),
  output: Schema.NullOr(Schema.Finite),
  cache_read: Schema.NullOr(Schema.Finite),
  cache_write: Schema.NullOr(Schema.Finite),
  // SQLite has no boolean: 1 or 0.
  reported: Schema.Finite,
  recorded_at: Schema.String,
});

export type TokenUsageRow = typeof TokenUsageRow.Type;
