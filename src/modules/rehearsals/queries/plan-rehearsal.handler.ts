import * as Effect from "effect/Effect";

import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { type PlanRehearsalPayload, RehearsalPlan } from "./plan-rehearsal.query.ts";

export const planRehearsalHandler = Effect.fn("planRehearsalHandler")(function* (
  query: PlanRehearsalPayload,
) {
  return yield* Effect.sync(() =>
    RehearsalPlan.make({
      standIns: ScenarioRootOps.standIns(query.scenario, ScenarioRootOps.replayed(query.replayed)),
    }),
  );
});
