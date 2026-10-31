import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ScenarioInvalid } from "../domain/scenario/scenario.errors.ts";
import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { ScenarioSpecifications } from "../domain/scenario/scenario.specification.ts";
import { ScenariosRepository } from "../domain/scenario/scenarios.repository.ts";
import { LoadedScenario, type LoadScenarioPayload } from "./load-scenario.query.ts";

export const loadScenarioHandler = Effect.fn("loadScenarioHandler")(function* (
  request: LoadScenarioPayload,
) {
  const found = yield* (yield* ScenariosRepository).findOne(
    ScenarioSpecifications.atPath(request.path),
  );

  if (Option.isNone(found)) {
    return yield* new ScenarioInvalid({ message: `${request.path}: no such scenario file` });
  }

  const scenario = found.value;
  const flow = yield* Effect.fromResult(ScenarioRootOps.flowOf(scenario, request.flow));

  const enrolled = yield* Effect.fromResult(
    ScenarioRootOps.target(scenario, request.enrolled, request.allowEnrolled),
  );

  return LoadedScenario.make({ scenario, flow, enrolled });
});
