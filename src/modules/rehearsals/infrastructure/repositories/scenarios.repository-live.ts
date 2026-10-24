// Scenario files, read as YAML from wherever a person keeps them, by their
// absolute path. A key the scenario schema doesn't know is refused, as in
// the team's config, since a misspelt expect: would otherwise pass unseen.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ScenarioFile } from "../../../../kernel/scenario.value-object.ts";
import { readYaml } from "../../../../repo-config.ts";
import { ScenariosRepository } from "../../domain/ports/repositories/scenarios.repository.ts";
import { ScenarioInvalid } from "../../domain/scenario/scenario.errors.ts";
import { toRoot } from "./scenario.mapper.ts";

export const ScenariosRepositoryLive = Layer.effect(
  ScenariosRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const findOne = (path: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path))) {
          return yield* new ScenarioInvalid({ message: `${path}: no such scenario file` });
        }

        return toRoot(path, yield* readYaml(ScenarioFile, path, true));
      }).pipe(
        Effect.catchTags({
          ConfigError: (error) => Effect.fail(new ScenarioInvalid({ message: error.message })),
          PlatformError: (error) =>
            Effect.fail(new ScenarioInvalid({ message: `${path}: ${error.message}` })),
        }),
        Effect.provideService(FileSystem.FileSystem, fs),
      );

    return ScenariosRepository.of({ findOne });
  }),
);
