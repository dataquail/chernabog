import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RecipeFilesFailed, RecipePackageUnavailable } from "../domain/recipe/recipe.errors.ts";

// A recipe package made sure of in .chernabog/: added at the newest version
// for the repo's SDK, or already declared.
export class RecipePackageAdded extends Schema.Class<
  RecipePackageAdded,
  { readonly brand: "RecipePackageAdded" }
>("RecipePackageAdded")({
  package: Schema.String,
  version: Schema.String,
  change: Schema.Literals(["added", "present"]),
}) {}

// Makes sure the repo at `root` has a recipe package installed in its
// .chernabog/, to copy recipes from: one it declares already is installed
// as it's declared; otherwise it's added as a dev dependency, at the newest
// version whose SDK range includes the repo's SDK pin.
export const AddRecipePackageCommand = Command.make("AddRecipePackageCommand", {
  payload: { root: Schema.String, name: Schema.String },
  success: RecipePackageAdded,
  failure: Schema.Union([RecipeFilesFailed, RecipePackageUnavailable]),
});

export type AddRecipePackagePayload = Command.Payload<typeof AddRecipePackageCommand>;
