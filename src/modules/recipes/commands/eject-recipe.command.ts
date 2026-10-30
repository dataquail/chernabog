import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import {
  FlowNotImported,
  RecipeFilesFailed,
  RecipePackageMissing,
  RecipePackageUnavailable,
  UnknownRecipe,
} from "../domain/recipe/recipe.errors.ts";
import { RecipeWrite } from "./add-recipes.command.ts";

// An imported flow copied into the repo: the files written, and the ones it
// kept because the repo has its own.
export class RecipeEjected extends Schema.Class<RecipeEjected, { readonly brand: "RecipeEjected" }>(
  "RecipeEjected",
)({
  flow: Schema.String,
  recipe: Schema.String,
  version: Schema.String,
  files: Schema.Array(RecipeWrite),
}) {}

// Turns a flow the repo at `root` imports into one it owns: the flow, as
// flows/<flow>, and its prompts and steps are copied in from the version of
// the package installed and recorded as from it, and config.yaml's `from`
// goes, so the flow runs under the same name and settings. A prompt or step
// the repo has already, which overrode the package's, is kept.
export const EjectRecipeCommand = Command.make("EjectRecipeCommand", {
  payload: { root: Schema.String, flow: Schema.String },
  success: RecipeEjected,
  failure: Schema.Union([
    FlowNotImported,
    RecipeFilesFailed,
    RecipePackageMissing,
    RecipePackageUnavailable,
    UnknownRecipe,
  ]),
});

export type EjectRecipePayload = Command.Payload<typeof EjectRecipeCommand>;
