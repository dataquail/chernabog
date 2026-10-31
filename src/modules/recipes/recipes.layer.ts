import * as Layer from "effect/Layer";

import { BundleClientLive } from "./infrastructure/clients/bundle.client-live.ts";
import { ChernabogDirClientLive } from "./infrastructure/clients/chernabog-dir.client-live.ts";
import { RecipePackagesClientLive } from "./infrastructure/clients/recipe-packages.client-live.ts";
import { TextDiffClientLive } from "./infrastructure/clients/text-diff.client-live.ts";
import { FlowImportsRepositoryLive } from "./infrastructure/repositories/flow-imports.repository-live.ts";
import { TeamConfigsRepositoryLive } from "./infrastructure/repositories/team-configs.repository-live.ts";

// The recipes module's live adapters, for a composition root to provide.
export const RecipesLayer = Layer.mergeAll(
  ChernabogDirClientLive,
  BundleClientLive,
  RecipePackagesClientLive,
  TextDiffClientLive,
  FlowImportsRepositoryLive,
  TeamConfigsRepositoryLive,
);
