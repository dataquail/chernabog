import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowPlan } from "./flow-plan.value-object.ts";

// The plan a run started with: the plan of the flow it ran, as it was then,
// so editing the flow's document never draws an old run on the wrong plan.
// A plan is kept once by its hash, which the runs of one plan share.
export class RunPlanEntity extends Schema.Class<RunPlanEntity, { readonly brand: "RunPlanEntity" }>(
  "RunPlanEntity",
)({
  runId: RunId,
  hash: Schema.String,
  plan: FlowPlan,
}) {}
