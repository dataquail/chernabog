// Scenario files, read as YAML from wherever a person keeps them, by their
// absolute path, which the spec pins. A key the scenario schema doesn't know
// is refused, as in the team's config, since a misspelt expect: would
// otherwise pass unseen.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ScenarioFile } from "../../../../kernel/scenario.value-object.ts";
import { pinnedValue, type Specification } from "../../../../kernel/specification.ts";
import { readYaml } from "../../../../repo-config.ts";
import { ScenarioInvalid } from "../../domain/scenario/scenario.errors.ts";
import { type ScenarioRoot } from "../../domain/scenario/scenario.root.ts";
import { ScenariosRepository } from "../../domain/scenario/scenarios.repository.ts";
import { toRoot } from "./scenario.mapper.ts";

export const ScenariosRepositoryLive = Layer.effect(
  ScenariosRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = (path: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path))) {
          return Option.none<ScenarioRoot>();
        }

        return Option.some(toRoot(path, yield* readYaml(ScenarioFile, path, true)));
      }).pipe(
        Effect.catchTags({
          ConfigError: (error) => Effect.fail(new ScenarioInvalid({ message: error.message })),
          PlatformError: (error) =>
            Effect.fail(new ScenarioInvalid({ message: `${path}: ${error.message}` })),
        }),
        Effect.provideService(FileSystem.FileSystem, fs),
      );

    // A spec that names no file is a bug in its caller: there is no listing
    // of every scenario a person keeps.
    const findOne = (spec: Specification<ScenarioRoot>) =>
      Option.match(pinnedValue(spec.criteria, "path"), {
        onNone: () => Effect.die(new Error("a scenario is read by its path")),
        onSome: (path) => read(String(path)).pipe(Effect.map(Option.filter(spec))),
      });

    return ScenariosRepository.of({ findOne });
  }),
);
