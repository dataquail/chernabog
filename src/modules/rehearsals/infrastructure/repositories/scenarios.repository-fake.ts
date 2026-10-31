import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type ScenarioRoot } from "../../domain/scenario/scenario.root.ts";
import { ScenariosRepository } from "../../domain/scenario/scenarios.repository.ts";

// Scenarios by path; a path not listed has no file.
export const ScenariosRepositoryFake = (scenarios: Readonly<Record<string, ScenarioRoot>>) =>
  Layer.succeed(
    ScenariosRepository,
    ScenariosRepository.of({
      findOne: (spec) => Effect.succeed(Arr.findFirst(Object.values(scenarios), spec)),
    }),
  );
