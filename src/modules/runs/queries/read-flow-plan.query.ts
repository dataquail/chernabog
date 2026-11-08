import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

// A plan runs started with, as state.db keeps it: the plan's JSON, which the
// runs module's FlowPlan decodes; none when no run started with it.
export class PlanView extends Schema.Class<PlanView, { readonly brand: "PlanView" }>("PlanView")({
  plan: Schema.Option(Schema.Json),
}) {}

// A plan a run started with, by its hash (RunHistory's `plan`).
export const ReadFlowPlanQuery = Query.make("ReadFlowPlanQuery", {
  payload: { hash: Schema.String },
  success: PlanView,
});

export type ReadFlowPlanPayload = Query.Payload<typeof ReadFlowPlanQuery>;
