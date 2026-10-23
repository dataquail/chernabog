import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BundleClient } from "../domain/ports/clients/bundle.client.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { RecipesAdded } from "./recipe.result.ts";

// Bakes the recipes a person names into the repo at `root`, never overwriting
// a file that is there: a flow of that name is the repo's own, and a prompt
// another recipe brought is shared. A name that isn't a recipe is refused
// before anything is written.
export const addRecipesUseCase = Effect.fn("addRecipesUseCase")(function* (
  root: string,
  names: ReadonlyArray<string>,
) {
  const recipes = yield* Effect.fromResult(RecipeRootOps.allNamed(names));
  const dir = yield* ChernabogDirClient;
  const bundle = yield* BundleClient;
  const files: Array<(typeof RecipesAdded.Type.files)[number]> = [];

  for (const recipe of recipes) {
    for (const file of recipe.files) {
      const path = `.chernabog/${file}`;

      if (Option.isSome(yield* dir.read(root, path))) {
        if (file === RecipeRootOps.flowFileOf(recipe)) {
          files.push({ file: path, recipe: recipe.name, outcome: "kept" });
        }

        continue;
      }

      yield* dir.write(root, path, yield* bundle.recipeFile(file));
      files.push({ file: path, recipe: recipe.name, outcome: "wrote" });
    }
  }

  return RecipesAdded.make({ files });
});
