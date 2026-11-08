// What runs' agent calls spent, in om_agent_usage, in state.db beside the
// runs that made them: one row per call and model, or one with no model for a
// call whose adapter couldn't say. A run from before usage was kept has none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type TokenUsageRoot } from "../../domain/token-usage/token-usage.root.ts";
import { TokenUsagesRepository } from "../../domain/token-usage/token-usages.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { TokenUsageColumns, tokenUsageColumns, toRoot, toRow } from "./token-usage.mapper.ts";

export const TokenUsagesRepositoryLive = Layer.effect(
  TokenUsagesRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_agent_usage (
      run_id TEXT NOT NULL,
      step TEXT,
      adapter TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT,
      input INTEGER,
      output INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      reported INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS om_agent_usage_by_run ON om_agent_usage (run_id)`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const findMany = (spec: Specification<TokenUsageRoot>) =>
      criteriaToWhere(sql, spec.criteria, tokenUsageColumns).pipe(
        Effect.flatMap((where) => sql`SELECT * FROM om_agent_usage WHERE ${where} ORDER BY rowid`),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TokenUsageColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const insertMany = (usages: ReadonlyArray<TokenUsageRoot>) =>
      Effect.forEach(
        usages.map(toRow),
        (row) =>
          sql`INSERT INTO om_agent_usage (run_id, step, adapter, session_id, model, input, output, cache_read, cache_write, reported, recorded_at)
            VALUES (${row.run_id}, ${row.step}, ${row.adapter}, ${row.session_id}, ${row.model}, ${row.input}, ${row.output}, ${row.cache_read}, ${row.cache_write}, ${row.reported}, ${row.recorded_at})`,
        { discard: true },
      ).pipe(Effect.orDie);

    return TokenUsagesRepository.of({ findMany, insertMany });
  }).pipe(Effect.orDie),
);
