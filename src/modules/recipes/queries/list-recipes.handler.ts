import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowImportSpecifications } from "../domain/flow-import/flow-import.specification.ts";
import { FlowImportsRepository } from "../domain/flow-import/flow-imports.repository.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { type ListRecipesPayload, RecipeList } from "./list-recipes.query.ts";

const stateOf = (copied: boolean, imported: boolean) => {
  if (imported) {
    return "imported" as const;
  }

  if (copied) {
    return "copied" as const;
  }

  return "available" as const;
};

export const listRecipesHandler = Effect.fn("listRecipesHandler")(function* (
  query: ListRecipesPayload,
) {
  const { root } = query;
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

  const imported = new Set(
    (yield* (yield* FlowImportsRepository)
      .findMany(FlowImportSpecifications.inCheckout(root))
      .pipe(Effect.mapError((error) => new RecipeFilesFailed({ message: error.message })))).map(
      (each) => RecipeRootOps.fullRef(each.from),
    ),
  );

  return RecipeList.make({
    packages: installed.map(({ name, version }) => ({ name, version })),
    recipes: recipes.map((recipe) => ({
      ref: RecipeRootOps.refOf(recipe),
      package: recipe.package,
      version: recipe.version,
      description: recipe.description,
      docs: RecipeRootOps.docsOf(recipe),
      state: stateOf(copied.includes(recipe), imported.has(`${recipe.package}/${recipe.name}`)),
    })),
  });
});
