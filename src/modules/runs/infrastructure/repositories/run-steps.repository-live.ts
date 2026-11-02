// Steps in om_steps, in state.db beside the runs that took them. A run from
// before steps were kept has none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { RunStepsRepository } from "../../domain/run/run-steps.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { StepColumns, stepColumns, toEntity } from "./run-step.mapper.ts";

const ColumnName = Schema.Struct({ name: Schema.String });

export const RunStepsRepositoryLive = Layer.effect(
  RunStepsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_steps (
      run_id TEXT NOT NULL,
      step TEXT NOT NULL,
      entered_at TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS om_steps_by_run ON om_steps (run_id)`;

    // A database from before steps kept their ends gains the columns; its steps have none.
    const columns = yield* sql`SELECT name FROM pragma_table_info('om_steps')`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ColumnName))),
    );

    if (!columns.some((column) => column.name === "finished_at")) {
      yield* sql`ALTER TABLE om_steps ADD COLUMN finished_at TEXT`;
      yield* sql`ALTER TABLE om_steps ADD COLUMN outcome TEXT`;
    }

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    // Rows are added in the order a run enters them, so rowid breaks a tie in time.
    const findMany = (spec: Specification<RunStepEntity>) =>
      criteriaToWhere(sql, spec.criteria, stepColumns).pipe(
        Effect.flatMap(
          (where) => sql`SELECT * FROM om_steps WHERE ${where} ORDER BY entered_at, rowid`,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StepColumns))),
        Effect.map((rows) => rows.map(toEntity)),
        Effect.orDie,
      );

    const insertOne = (step: RunStepEntity) =>
      sql`INSERT INTO om_steps (run_id, step, entered_at, finished_at, outcome) VALUES (${step.runId}, ${step.step}, ${step.enteredAt}, ${Option.getOrNull(step.finishedAt)}, ${Option.getOrNull(step.outcome)})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    // A step is the run's entry into it at its time.
    const updateOne = (step: RunStepEntity) =>
      sql`UPDATE om_steps SET finished_at = ${Option.getOrNull(step.finishedAt)}, outcome = ${Option.getOrNull(step.outcome)} WHERE run_id = ${step.runId} AND step = ${step.step} AND entered_at = ${step.enteredAt}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return RunStepsRepository.of({ findMany, insertOne, updateOne });
  }).pipe(Effect.orDie),
);
