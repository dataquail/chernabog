// Steps in om_steps, in state.db beside the runs that took them. A run from
// before steps were kept has none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepsRepository } from "../../domain/ports/repositories/run-steps.repository.ts";
import { type RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { StepColumns, toEntity } from "./run-step.mapper.ts";

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

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    // Rows are added in the order a run enters them, so rowid breaks a tie in time.
    const findAll = (runId: RunId) =>
      sql`SELECT * FROM om_steps WHERE run_id = ${runId} ORDER BY entered_at, rowid`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StepColumns))),
        Effect.map((rows) => rows.map(toEntity)),
        Effect.orDie,
      );

    const save = (step: RunStepEntity) =>
      sql`INSERT INTO om_steps (run_id, step, entered_at) VALUES (${step.runId}, ${step.step}, ${step.enteredAt})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return RunStepsRepository.of({ findAll, save });
  }).pipe(Effect.orDie),
);
