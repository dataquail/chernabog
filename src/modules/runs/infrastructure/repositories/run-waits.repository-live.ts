// Waits in om_waits, in state.db beside the runs they park.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunWaitRoot } from "../../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepository } from "../../domain/run-wait/run-waits.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { toRoot, WaitColumns, waitColumns } from "./run-wait.mapper.ts";

const ColumnName = Schema.Struct({ name: Schema.String });

export const RunWaitsRepositoryLive = Layer.effect(
  RunWaitsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_waits (
      run_id TEXT NOT NULL,
      signal TEXT NOT NULL,
      deferred TEXT NOT NULL,
      token TEXT NOT NULL,
      PRIMARY KEY (run_id, deferred)
    )`;

    // A database from before waits kept when they parked gains the column; its waits have none.
    const columns = yield* sql`SELECT name FROM pragma_table_info('om_waits')`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ColumnName))),
    );

    if (!columns.some((column) => column.name === "parked_at")) {
      yield* sql`ALTER TABLE om_waits ADD COLUMN parked_at TEXT`;
    }

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const waits = <E>(query: Effect.Effect<ReadonlyArray<object>, E>) =>
      query.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(WaitColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const findMany = (spec: Specification<RunWaitRoot>) =>
      criteriaToWhere(sql, spec.criteria, waitColumns).pipe(
        Effect.flatMap((where) => waits(sql`SELECT * FROM om_waits WHERE ${where} ORDER BY rowid`)),
      );

    const upsertOne = (wait: RunWaitRoot) =>
      sql`INSERT OR REPLACE INTO om_waits (run_id, signal, deferred, token, parked_at) VALUES (${wait.runId}, ${wait.signal}, ${wait.deferred}, ${wait.token}, ${Option.getOrNull(wait.parkedAt)})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    const deleteOne = (wait: RunWaitRoot) =>
      sql`DELETE FROM om_waits WHERE run_id = ${wait.runId} AND deferred = ${wait.deferred}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return RunWaitsRepository.of({ findMany, upsertOne, deleteOne });
  }).pipe(Effect.orDie),
);
