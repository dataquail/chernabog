import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { StandIns } from "../../../kernel/stand-in.value-object.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";

// What answers for the agent in a rehearsal, by step.
export class RehearsalPlan extends Schema.Class<RehearsalPlan, { readonly brand: "RehearsalPlan" }>(
  "RehearsalPlan",
)({
  standIns: StandIns,
}) {}

// One answer a replayed run's agent gave, with the commits its step made.
export const ReplayedAnswer = Schema.Struct({
  step: Schema.String,
  answer: Schema.Json,
  commits: Schema.Array(Schema.String),
});

// The stand-ins a rehearsal runs with: a replayed run's answers, if it
// replays one, with the scenario's own over them.
export const PlanRehearsalQuery = Query.make("PlanRehearsalQuery", {
  payload: { scenario: ScenarioRoot, replayed: Schema.Array(ReplayedAnswer) },
  success: RehearsalPlan,
});

export type PlanRehearsalPayload = Query.Payload<typeof PlanRehearsalQuery>;
