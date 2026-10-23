// Skips in om_skips, in state.db: a log the daemon appends to and `status` reads.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { SkipsRepository } from "../../domain/ports/repositories/skips.repository.ts";
import { type SkipRoot } from "../../domain/skip/skip.root.ts";
import { nullable, SkipColumns, toRoot } from "./skip.mapper.ts";

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
    const findAll = (latest: number) =>
      sql`SELECT * FROM om_skips ORDER BY at DESC LIMIT ${latest}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SkipColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const save = (skip: SkipRoot) =>
      sql`INSERT INTO om_skips (repo, persona, flow, item_key, reason, at) VALUES (${skip.repo}, ${nullable(skip.persona)}, ${skip.flow}, ${nullable(skip.itemKey)}, ${skip.reason}, ${skip.at})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return SkipsRepository.of({ findAll, save });
  }).pipe(Effect.orDie),
);
