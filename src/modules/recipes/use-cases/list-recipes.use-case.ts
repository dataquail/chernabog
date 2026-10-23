import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { RECIPES } from "../domain/recipe/recipe-catalog.value-object.ts";
import { RecipeList } from "./recipe.result.ts";

// The recipes, each with whether the repo at `root` has it: what a person
// chooses which to bake from.
export const listRecipesUseCase = Effect.fn("listRecipesUseCase")(function* (root: string) {
  const dir = yield* ChernabogDirClient;
  const has: Array<string> = [];

  for (const recipe of RECIPES) {
    const file = RecipeRootOps.flowFileOf(recipe);

    if (Option.isSome(yield* dir.read(root, `.chernabog/${file}`))) {
      has.push(file);
    }
  }

  const installed = RecipeRootOps.installed((file) => has.includes(file));

  return RecipeList.make({
    recipes: RECIPES.map((recipe) => ({
      name: recipe.name,
      description: recipe.description,
      docs: RecipeRootOps.docsOf(recipe),
      installed: installed.includes(recipe),
    })),
  });
});
