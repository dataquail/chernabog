import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import {
  RecipeFilesFailed,
  RecipePackageMissing,
  RecipePackageUnavailable,
  UnknownRecipe,
} from "../domain/recipe/recipe.errors.ts";

// One file copying recipes touched: written, or kept because the repo has
// its own.
export const RecipeWrite = Schema.Struct({
  file: Schema.String,
  recipe: Schema.String,
  version: Schema.String,
  outcome: Schema.Literals(["wrote", "kept"]),
});

export class RecipesAdded extends Schema.Class<RecipesAdded, { readonly brand: "RecipesAdded" }>(
  "RecipesAdded",
)({
  files: Schema.Array(RecipeWrite),
}) {}

// Copies the recipes a person names, from the packages installed in the
// repo's .chernabog/, into the repo at `root`, never overwriting a file that
// is there: a flow of that name is the repo's own, and a prompt another
// recipe brought is shared. Each file written is recorded in package.json with
// the package version it came from. A name that isn't a recipe is refused
// before anything is written.
export const AddRecipesCommand = Command.make("AddRecipesCommand", {
  payload: { root: Schema.String, names: Schema.Array(Schema.String) },
  success: RecipesAdded,
  failure: Schema.Union([
    RecipeFilesFailed,
    RecipePackageMissing,
    RecipePackageUnavailable,
    UnknownRecipe,
  ]),
});

export type AddRecipesPayload = Command.Payload<typeof AddRecipesCommand>;
