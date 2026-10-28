// Markers in om_markers, in state.db beside the runs that hold them.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type MarkerQuery,
  RunMarkersRepository,
} from "../../domain/ports/repositories/run-markers.repository.ts";
import { type RunMarkerRoot } from "../../domain/run-marker/run-marker.root.ts";
import { MarkerColumns, toRoot, toRow } from "./run-marker.mapper.ts";

export const RunMarkersRepositoryLive = Layer.effect(
  RunMarkersRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_markers (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      args TEXT NOT NULL,
      keep_on TEXT NOT NULL,
      status TEXT NOT NULL,
      held_at TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      last_error TEXT,
      next_attempt_at TEXT,
      settled_at TEXT,
      UNIQUE (run_id, name, args)
    )`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const markers = <E>(query: Effect.Effect<ReadonlyArray<object>, E>) =>
      query.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MarkerColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const findAll = (query: MarkerQuery) => {
      const conditions = [
        ...Option.toArray(Option.map(query.runId, (runId) => sql`run_id = ${runId}`)),
        ...Option.toArray(Option.map(query.status, (status) => sql`status = ${status}`)),
      ];

      const where = Option.match(
        Option.liftPredicate(conditions, (all) => all.length > 0),
        {
          onNone: () => sql``,
          onSome: (all) => sql`WHERE ${sql.and(all)}`,
        },
      );

      return markers(
        sql`SELECT run_id, name, args, keep_on, status, held_at, attempts, last_error, next_attempt_at, settled_at FROM om_markers ${where} ORDER BY seq`,
      );
    };

    const save = (marker: RunMarkerRoot) => {
      const row = toRow(marker);

      return sql`INSERT INTO om_markers (run_id, name, args, keep_on, status, held_at, attempts, last_error, next_attempt_at, settled_at)
        VALUES (${row.run_id}, ${row.name}, ${row.args}, ${row.keep_on}, ${row.status}, ${row.held_at}, ${row.attempts}, ${row.last_error}, ${row.next_attempt_at}, ${row.settled_at})
        ON CONFLICT (run_id, name, args) DO UPDATE SET keep_on = excluded.keep_on, status = excluded.status, held_at = excluded.held_at, attempts = excluded.attempts, last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at, settled_at = excluded.settled_at`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );
    };

    const remove = (marker: RunMarkerRoot) =>
      sql`DELETE FROM om_markers WHERE run_id = ${marker.runId} AND name = ${marker.name} AND args = ${toRow(marker).args}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return RunMarkersRepository.of({ findAll, save, remove });
  }).pipe(Effect.orDie),
);
