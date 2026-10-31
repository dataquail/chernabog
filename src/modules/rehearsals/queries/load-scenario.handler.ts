import * as Effect from "effect/Effect";

import { ScenariosRepository } from "../domain/ports/repositories/scenarios.repository.ts";
import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { LoadedScenario, type LoadScenarioPayload } from "./load-scenario.query.ts";

export const loadScenarioHandler = Effect.fn("loadScenarioHandler")(function* (
  request: LoadScenarioPayload,
) {
  const scenario = yield* (yield* ScenariosRepository).findOne(request.path);
  const flow = yield* Effect.fromResult(ScenarioRootOps.flowOf(scenario, request.flow));

  const enrolled = yield* Effect.fromResult(
    ScenarioRootOps.target(scenario, request.enrolled, request.allowEnrolled),
  );

  return LoadedScenario.make({ scenario, flow, enrolled });
});
