// Each agent session's usage cursor, in om_usage_cursors, in state.db: one
// per adapter and session, whichever run the session was last used in.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type TokenUsageCursorRoot } from "../../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorsRepository } from "../../domain/token-usage-cursor/token-usage-cursors.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import {
  TokenUsageCursorColumns,
  tokenUsageCursorColumns,
  toRoot,
} from "./token-usage-cursor.mapper.ts";

export const TokenUsageCursorsRepositoryLive = Layer.effect(
  TokenUsageCursorsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_usage_cursors (
      adapter TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      PRIMARY KEY (adapter, session_id)
    )`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const findOne = (spec: Specification<TokenUsageCursorRoot>) =>
      criteriaToWhere(sql, spec.criteria, tokenUsageCursorColumns).pipe(
        Effect.flatMap((where) => sql`SELECT * FROM om_usage_cursors WHERE ${where} LIMIT 1`),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TokenUsageCursorColumns))),
        Effect.map((rows) => Arr.head(rows.map(toRoot))),
        Effect.orDie,
      );

    const upsertOne = (cursor: TokenUsageCursorRoot) =>
      sql`INSERT INTO om_usage_cursors (adapter, session_id, cursor)
        VALUES (${cursor.adapter}, ${cursor.sessionId}, ${cursor.cursor})
        ON CONFLICT (adapter, session_id) DO UPDATE SET cursor = excluded.cursor`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return TokenUsageCursorsRepository.of({ findOne, upsertOne });
  }).pipe(Effect.orDie),
);
