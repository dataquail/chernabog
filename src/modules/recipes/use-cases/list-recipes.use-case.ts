import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { RecipeList } from "./recipe.result.ts";

// The recipes of every recipe package the repo at `root` has installed in its
// .chernabog/, each with whether the repo copied it: what a person chooses
// which to copy from.
export const listRecipesUseCase = Effect.fn("listRecipesUseCase")(function* (root: string) {
  const dir = yield* ChernabogDirClient;
  const packages = yield* RecipePackagesClient;

  yield* packages.restore(root);

  const installed = yield* packages.installed(root);
  const recipes = RecipeRootOps.recipesOf(installed);
  const has: Array<string> = [];

  for (const recipe of recipes) {
    const file = RecipeRootOps.flowFileOf(recipe);

    if (Option.isSome(yield* dir.read(root, `.chernabog/${file}`))) {
      has.push(file);
    }
  }

  const copied = RecipeRootOps.copiedIn(installed, (file) => has.includes(file));

  return RecipeList.make({
    packages: installed.map(({ name, version }) => ({ name, version })),
    recipes: recipes.map((recipe) => ({
      ref: RecipeRootOps.refOf(recipe),
      package: recipe.package,
      version: recipe.version,
      description: recipe.description,
      docs: RecipeRootOps.docsOf(recipe),
      state: Option.getOrElse(
        Option.as(
          Option.liftPredicate(recipe, (found) => copied.includes(found)),
          "copied" as const,
        ),
        () => "available" as const,
      ),
    })),
  });
});
