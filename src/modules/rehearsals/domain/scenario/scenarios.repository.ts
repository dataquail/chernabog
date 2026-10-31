import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Specification } from "../../../../kernel/specification.ts";
import { type ScenarioInvalid } from "./scenario.errors.ts";
import { type ScenarioRoot } from "./scenario.root.ts";

// The scenario files a person writes, such as .chernabog/rehearsals/<name>.yaml.
// Chernabog only reads them, so a read names the file: a spec pins `path`
// (ScenarioSpecifications.atPath). A file that isn't there is none; one that
// doesn't read as a scenario fails.
export type ScenariosRepositoryService = {
  readonly findOne: (
    spec: Specification<ScenarioRoot>,
  ) => Effect.Effect<Option.Option<ScenarioRoot>, ScenarioInvalid>;
};

export class ScenariosRepository extends Context.Service<
  ScenariosRepository,
  ScenariosRepositoryService
>()("ScenariosRepository") {}
