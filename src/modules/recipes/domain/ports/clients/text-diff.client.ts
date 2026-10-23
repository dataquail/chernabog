import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type RecipeFilesFailed } from "../../recipe/recipe.errors.ts";

// Two versions of a .chernabog/ file, as a unified diff with the recipe's side
// first; empty when they match.
export type TextDiffClientService = {
  readonly diff: (
    file: string,
    recipe: string,
    repo: string,
  ) => Effect.Effect<string, RecipeFilesFailed>;
};

export class TextDiffClient extends Context.Service<TextDiffClient, TextDiffClientService>()(
  "TextDiffClient",
) {}
