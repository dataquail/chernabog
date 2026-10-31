// Skips in om_skips, in state.db: a log the daemon appends to and `status` reads.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type SkipRoot } from "../../domain/skip/skip.root.ts";
import { SkipsRepository } from "../../domain/skip/skips.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { nullable, SkipColumns, skipColumns, toRoot } from "./skip.mapper.ts";

const ColumnName = Schema.Struct({ name: Schema.String });

export const SkipsRepositoryLive = Layer.effect(
  SkipsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_skips (
      repo TEXT NOT NULL,
      flow TEXT NOT NULL,
      item_key TEXT,
      reason TEXT NOT NULL,
      at TEXT NOT NULL
    )`;

    // A database from before personas gains the column; its rows read as the implicit persona.
    const columns = yield* sql`SELECT name FROM pragma_table_info('om_skips')`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ColumnName))),
    );

    if (!columns.some((column) => column.name === "persona")) {
      yield* sql`ALTER TABLE om_skips ADD COLUMN persona TEXT`;
    }

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const findMany = (spec: Specification<SkipRoot>) =>
      criteriaToWhere(sql, spec.criteria, skipColumns).pipe(
        Effect.flatMap(
          (where) => sql`SELECT * FROM om_skips WHERE ${where} ORDER BY at DESC, rowid DESC`,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SkipColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const insertOne = (skip: SkipRoot) =>
      sql`INSERT INTO om_skips (repo, persona, flow, item_key, reason, at) VALUES (${skip.repo}, ${nullable(skip.persona)}, ${skip.flow}, ${nullable(skip.itemKey)}, ${skip.reason}, ${skip.at})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return SkipsRepository.of({ findMany, insertOne });
  }).pipe(Effect.orDie),
);
