import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { TokenUsageCursorRow } from "../storage/token-usage-cursor.schema.ts";
import {
  type ReadTokenUsageCursorPayload,
  TokenUsageCursorView,
} from "./read-token-usage-cursor.query.ts";

export const readTokenUsageCursorHandler = Effect.fn("readTokenUsageCursorHandler")(function* ({
  adapter,
  sessionId,
}: ReadTokenUsageCursorPayload) {
  const sql = yield* SqlClient.SqlClient;

  // A query over the runs' own table: a failure is a bug, not a condition.
  const rows = yield* sql`SELECT * FROM om_usage_cursors
    WHERE adapter = ${adapter} AND session_id = ${sessionId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TokenUsageCursorRow))),
    Effect.orDie,
  );

  return TokenUsageCursorView.make({
    cursor: Option.map(Arr.head(rows), (row) => row.cursor),
  });
});
