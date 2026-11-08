// The plans runs started with, in state.db: each plan once in om_plans, by
// its hash, which the runs of one plan share, and each run's hash in
// om_run_plans. A run of a flow with no plan, or from before runs kept
// theirs, has none.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { FlowPlan } from "../../domain/plan/flow-plan.value-object.ts";
import { type RunPlanEntity } from "../../domain/plan/run-plan.entity.ts";
import { RunPlansRepository } from "../../domain/plan/run-plans.repository.ts";
import { PlanRow } from "../../storage/plan.schema.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { RunPlanColumns, runPlanColumns, toEntity } from "./run-plan.mapper.ts";

export const RunPlansRepositoryLive = Layer.effect(
  RunPlansRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_plans (
      hash TEXT PRIMARY KEY,
      plan TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS om_run_plans (
      run_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS om_run_plans_by_hash ON om_run_plans (hash)`;

    // Queries this adapter wrote against its own tables: a failure is a bug, not a condition.
    const findOne = (spec: Specification<RunPlanEntity>) =>
      criteriaToWhere(sql, spec.criteria, runPlanColumns).pipe(
        Effect.flatMap(
          (where) =>
            sql`SELECT om_run_plans.run_id AS run_id, om_run_plans.hash AS hash, om_plans.plan AS plan FROM om_run_plans JOIN om_plans ON om_plans.hash = om_run_plans.hash WHERE ${where} ORDER BY om_run_plans.rowid LIMIT 1`,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunPlanColumns))),
        Effect.map((rows) => Arr.head(rows.map(toEntity))),
        Effect.orDie,
      );

    // A plan is kept once by its hash, and a run keeps the plan it has.
    const insertOne = (started: RunPlanEntity) =>
      Effect.gen(function* () {
        const row = yield* Schema.encodeEffect(PlanRow)({
          hash: started.hash,
          plan: yield* Schema.encodeEffect(Schema.toCodecJson(FlowPlan))(started.plan),
        });

        yield* sql`INSERT OR IGNORE INTO om_plans (hash, plan) VALUES (${row.hash}, ${row.plan})`;
        yield* sql`INSERT OR IGNORE INTO om_run_plans (run_id, hash) VALUES (${started.runId}, ${started.hash})`;
      }).pipe(Effect.orDie);

    return RunPlansRepository.of({ findOne, insertOne });
  }).pipe(Effect.orDie),
);
