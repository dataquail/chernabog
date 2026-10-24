import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";

import { ScenariosRepository } from "../../domain/ports/repositories/scenarios.repository.ts";
import { ScenarioInvalid } from "../../domain/scenario/scenario.errors.ts";
import { type ScenarioRoot } from "../../domain/scenario/scenario.root.ts";

// Scenarios by path; a path not listed has no file.
export const ScenariosRepositoryFake = (scenarios: Readonly<Record<string, ScenarioRoot>>) =>
  Layer.succeed(
    ScenariosRepository,
    ScenariosRepository.of({
      findOne: (path) =>
        Effect.fromOption(Record.get(scenarios, path)).pipe(
          Effect.mapError(() => new ScenarioInvalid({ message: `${path}: no such scenario file` })),
        ),
    }),
  );
