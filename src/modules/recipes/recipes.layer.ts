import * as Layer from "effect/Layer";

import { BundleClientLive } from "./infrastructure/clients/bundle.client-live.ts";
import { ChernabogDirClientLive } from "./infrastructure/clients/chernabog-dir.client-live.ts";
import { RecipePackagesClientLive } from "./infrastructure/clients/recipe-packages.client-live.ts";
import { TextDiffClientLive } from "./infrastructure/clients/text-diff.client-live.ts";

// The recipes module's live adapters, for a composition root to provide.
export const RecipesLayer = Layer.mergeAll(
  ChernabogDirClientLive,
  BundleClientLive,
  RecipePackagesClientLive,
  TextDiffClientLive,
);
