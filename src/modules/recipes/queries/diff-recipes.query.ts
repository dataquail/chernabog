import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import {
  RecipeFilesFailed,
  RecipePackageMissing,
  RecipePackageUnavailable,
  UnknownRecipe,
} from "../domain/recipe/recipe.errors.ts";

// How one of the repo's .chernabog/ files stands against the recipe version
// it came from: missing, the same, or different (with the diff); or from no
// recipe. `version` is the package version compared with: the one recorded
// for the file, or the one installed when nothing is recorded.
export const RecipeDiffEntry = Schema.Struct({
  file: Schema.String,
  recipe: Schema.Option(Schema.String),
  version: Schema.Option(Schema.String),
  recorded: Schema.Boolean,
  docs: Schema.Option(Schema.String),
  state: Schema.Literals(["missing", "same", "differs", "unowned"]),
  diff: Schema.Option(Schema.String),
});

export class RecipesDiff extends Schema.Class<RecipesDiff, { readonly brand: "RecipesDiff" }>(
  "RecipesDiff",
)({
  files: Schema.Array(RecipeDiffEntry),
  // Whether .chernabog/ has a recipe package installed to compare with: none
  // in a repo whose recipes an earlier chernabog baked.
  packagesInstalled: Schema.Boolean,
}) {}

// How the repo's copied flows, and the prompts and steps their recipes bring,
// differ from the version of the recipe each was copied from, as recorded in
// .chernabog/package.json: the repo's own edits. A file with no record is
// compared with the installed version. With names, only those recipes';
// without, each flow from no recipe is listed as such.
export const DiffRecipesQuery = Query.make("DiffRecipesQuery", {
  payload: { root: Schema.String, names: Schema.Array(Schema.String) },
  success: RecipesDiff,
  failure: Schema.Union([
    RecipeFilesFailed,
    RecipePackageMissing,
    RecipePackageUnavailable,
    UnknownRecipe,
  ]),
});

export type DiffRecipesPayload = Query.Payload<typeof DiffRecipesQuery>;
