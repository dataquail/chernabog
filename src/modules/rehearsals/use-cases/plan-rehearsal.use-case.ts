import * as Effect from "effect/Effect";

import { type ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { type ReplayedAnswer, ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { RehearsalPlan } from "./rehearsal-plan.result.ts";

// The stand-ins a rehearsal runs with: a replayed run's answers, if it
// replays one, with the scenario's own over them.
export const planRehearsalUseCase = Effect.fn("planRehearsalUseCase")(function* (
  scenario: ScenarioRoot,
  replayed: ReadonlyArray<ReplayedAnswer>,
) {
  return yield* Effect.sync(() =>
    RehearsalPlan.make({
      standIns: ScenarioRootOps.standIns(scenario, ScenarioRootOps.replayed(replayed)),
    }),
  );
});
