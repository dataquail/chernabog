import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BundleClientLive } from "./infrastructure/clients/bundle.client-live.ts";
import { ChernabogDirClientLive } from "./infrastructure/clients/chernabog-dir.client-live.ts";
import { RecipePackagesClientLive } from "./infrastructure/clients/recipe-packages.client-live.ts";
import { TextDiffClientLive } from "./infrastructure/clients/text-diff.client-live.ts";
import { FlowImportsRepositoryLive } from "./infrastructure/repositories/flow-imports.repository-live.ts";
import {
  recipesCommandGroup,
  RecipesCommands,
  RecipesCommandsLive,
} from "./recipes.command-handlers.ts";
import { RecipesQueries, RecipesQueriesLive, recipesQueryGroup } from "./recipes.query-handlers.ts";

// The recipes module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide.
export const RecipesModule = {
  layer: Layer.mergeAll(RecipesCommandsLive, RecipesQueriesLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        ChernabogDirClientLive,
        BundleClientLive,
        RecipePackagesClientLive,
        TextDiffClientLive,
        FlowImportsRepositoryLive,
      ),
    ),
  ),

  // The module's slice of the application's buses: the groups `layer`'s
  // dispatchers answer, and those dispatchers, as the tables a bus routes by.
  routes: {
    commands: {
      groups: [recipesCommandGroup],
      tables: Effect.all([RecipesCommands.use(Effect.succeed)]),
    },
    queries: {
      groups: [recipesQueryGroup],
      tables: Effect.all([RecipesQueries.use(Effect.succeed)]),
    },
  },
};
