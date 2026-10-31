import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type ScenarioInvalid } from "../../scenario/scenario.errors.ts";
import { type ScenarioRoot } from "../../scenario/scenario.root.ts";

// The scenario files a person writes, such as .chernabog/rehearsals/<name>.yaml.
// Chernabog only reads them.
export type ScenariosRepositoryService = {
  readonly findOne: (path: string) => Effect.Effect<ScenarioRoot, ScenarioInvalid>;
};

export class ScenariosRepository extends Context.Service<
  ScenariosRepository,
  ScenariosRepositoryService
>()("ScenariosRepository") {}
