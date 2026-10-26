import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type RecipeFilesFailed } from "../../recipe/recipe.errors.ts";

// A 3-way merge's text, with conflict markers where both sides changed the
// same lines.
export type Merged = { readonly text: string; readonly conflicts: boolean };

export type TextDiffClientService = {
  // Two versions of a .chernabog/ file, as a unified diff with the recipe's
  // side first; empty when they match.
  readonly diff: (
    file: string,
    recipe: string,
    repo: string,
  ) => Effect.Effect<string, RecipeFilesFailed>;
  // The repo's version of a file with the changes a recipe made since `base`,
  // the version it was copied from.
  readonly merge: (
    file: string,
    base: string,
    repo: string,
    recipe: string,
  ) => Effect.Effect<Merged, RecipeFilesFailed>;
};

export class TextDiffClient extends Context.Service<TextDiffClient, TextDiffClientService>()(
  "TextDiffClient",
) {}
