// A plan a run started with, as state.db keeps it: the plan once in om_plans,
// by its hash, and the run's hash in om_run_plans.

import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowPlan } from "../../domain/plan/flow-plan.value-object.ts";
import { RunPlanEntity } from "../../domain/plan/run-plan.entity.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

const PlanText = Schema.fromJsonString(FlowPlan);

export const RunPlanColumns = Schema.Struct({
  run_id: Schema.String,
  hash: Schema.String,
  plan: PlanText,
});

export const toEntity = (row: typeof RunPlanColumns.Type) =>
  RunPlanEntity.make({ runId: RunId.make(row.run_id), hash: row.hash, plan: row.plan });

// Each field of a run's plan, as the column of the join a spec's WHERE names.
export const runPlanColumns: ColumnMap = {
  runId: "om_run_plans.run_id",
  hash: "om_run_plans.hash",
};
