// A session's usage cursor, as om_usage_cursors stores it.

import { TokenUsageCursorRoot } from "../../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorRow } from "../../storage/token-usage-cursor.schema.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

export const TokenUsageCursorColumns = TokenUsageCursorRow;

export const toRoot = (row: TokenUsageCursorRow) =>
  TokenUsageCursorRoot.make({
    adapter: row.adapter,
    sessionId: row.session_id,
    cursor: row.cursor,
  });

// Each field of a cursor, as the om_usage_cursors column a spec's WHERE names.
export const tokenUsageCursorColumns: ColumnMap = {
  adapter: "adapter",
  sessionId: "session_id",
  cursor: "cursor",
};
