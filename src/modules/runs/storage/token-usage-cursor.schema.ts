// A row of om_usage_cursors, in state.db: how far an adapter has read one
// session's records of what it spent. The cursors repository writes it and
// the runs queries read it, so its shape is named once, here.

import * as Schema from "effect/Schema";

export const TokenUsageCursorRow = Schema.Struct({
  adapter: Schema.String,
  session_id: Schema.String,
  cursor: Schema.String,
});

export type TokenUsageCursorRow = typeof TokenUsageCursorRow.Type;
