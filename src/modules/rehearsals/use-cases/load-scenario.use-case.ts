import * as Effect from "effect/Effect";

import { ScenariosRepository } from "../domain/ports/repositories/scenarios.repository.ts";
import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { LoadedScenario } from "./scenario.result.ts";

// Reads the scenario a person names for a flow, and refuses one that would
// seed a repo this machine is enrolled in (`enrolled`, by owner/name) unless
// the scenario or the person (`allowEnrolled`) says that's meant.
export const loadScenarioUseCase = Effect.fn("loadScenarioUseCase")(function* (request: {
  readonly path: string;
  readonly flow: string;
  readonly enrolled: ReadonlyArray<string>;
  readonly allowEnrolled: boolean;
}) {
  const scenario = yield* (yield* ScenariosRepository).findOne(request.path);
  const flow = yield* Effect.fromResult(ScenarioRootOps.flowOf(scenario, request.flow));

  const enrolled = yield* Effect.fromResult(
    ScenarioRootOps.target(scenario, request.enrolled, request.allowEnrolled),
  );

  return LoadedScenario.make({ scenario, flow, enrolled });
});
