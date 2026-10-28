import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RecipeFilesFailed } from "../../recipe/recipe.errors.ts";

// The flows a checkout at `root` imports from recipe packages: config.yaml's
// `flows.<name>.from`, as "<package>/<recipe>", by flow name.
export type FlowImportsRepositoryService = {
  readonly findAll: (root: string) => Effect.Effect<ReadonlyMap<string, string>, RecipeFilesFailed>;
  // Sets a flow's `from`, or with none removes it, keeping the flow's other
  // settings and the file's comments.
  readonly save: (
    root: string,
    flow: string,
    from: Option.Option<string>,
  ) => Effect.Effect<void, RecipeFilesFailed>;
};

export class FlowImportsRepository extends Context.Service<
  FlowImportsRepository,
  FlowImportsRepositoryService
>()("FlowImportsRepository") {}
