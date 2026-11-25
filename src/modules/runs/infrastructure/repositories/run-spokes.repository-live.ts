// Spokes' records in om_spokes, in state.db beside the runs they execute
// (ADR 23, decision 7).

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunSpokeRoot } from "../../domain/run-spoke/run-spoke.root.ts";
import { RunSpokesRepository } from "../../domain/run-spoke/run-spokes.repository.ts";
import { RunSpokeRow } from "../../storage/run-spoke.schema.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { spokeColumns, toRoot, toRow } from "./run-spoke.mapper.ts";

const encodeRow = Schema.encodeSync(RunSpokeRow);

export const RunSpokesRepositoryLive = Layer.effect(
  RunSpokesRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_spokes (
      run_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT,
      hub_pid INTEGER NOT NULL,
      hub_started_at TEXT,
      folded_seq INTEGER NOT NULL,
      ending TEXT
    )`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const spokes = <E>(query: Effect.Effect<ReadonlyArray<object>, E>) =>
      query.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSpokeRow))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const findMany = (spec: Specification<RunSpokeRoot>) =>
      criteriaToWhere(sql, spec.criteria, spokeColumns).pipe(
        Effect.flatMap((where) =>
          spokes(sql`SELECT * FROM om_spokes WHERE ${where} ORDER BY rowid`),
        ),
      );

    const findOne = (spec: Specification<RunSpokeRoot>) => Effect.map(findMany(spec), Arr.head);

    const upsertOne = (spoke: RunSpokeRoot) => {
      const row = encodeRow(toRow(spoke));

      return sql`INSERT OR REPLACE INTO om_spokes (run_id, pid, started_at, hub_pid, hub_started_at, folded_seq, ending) VALUES (${row.run_id}, ${row.pid}, ${row.started_at}, ${row.hub_pid}, ${row.hub_started_at}, ${row.folded_seq}, ${row.ending})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );
    };

    const deleteOne = (spoke: RunSpokeRoot) =>
      sql`DELETE FROM om_spokes WHERE run_id = ${spoke.runId}`.pipe(Effect.asVoid, Effect.orDie);

    return RunSpokesRepository.of({ findOne, findMany, upsertOne, deleteOne });
  }).pipe(Effect.orDie),
);
