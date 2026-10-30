import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import {
  RecipeFilesFailed,
  RecipePackageMissing,
  RecipePackageUnavailable,
  UnknownRecipe,
} from "../domain/recipe/recipe.errors.ts";

// One flow importing recipes touched: imported, already imported, or kept as
// it was, because the repo has a flow of that name or imports it from
// elsewhere.
export const RecipeImport = Schema.Struct({
  flow: Schema.String,
  recipe: Schema.String,
  version: Schema.String,
  outcome: Schema.Literals(["imported", "present", "kept"]),
  // Why it was kept: the file of that name, or the other recipe it imports.
  keptFor: Schema.Option(Schema.String),
});

export class RecipesImported extends Schema.Class<
  RecipesImported,
  { readonly brand: "RecipesImported" }
>("RecipesImported")({
  flows: Schema.Array(RecipeImport),
  // The packages moved to dependencies, which a snapshot installs.
  dependencies: Schema.Array(Schema.String),
}) {}

// Imports the recipes a person names into the repo at `root`: each runs from
// its package, under its recipe's name, with config.yaml's
// `flows.<name>.from`, and nothing is copied. A flow of that name already in
// flows/, or imported from another recipe, is kept, never replaced. Each
// package imported from moves to `dependencies`, which a snapshot installs.
export const ImportRecipesCommand = Command.make("ImportRecipesCommand", {
  payload: { root: Schema.String, names: Schema.Array(Schema.String) },
  success: RecipesImported,
  failure: Schema.Union([
    RecipeFilesFailed,
    RecipePackageMissing,
    RecipePackageUnavailable,
    UnknownRecipe,
  ]),
});

export type ImportRecipesPayload = Command.Payload<typeof ImportRecipesCommand>;
