import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RecipeFilesFailed, ScaffoldRefused } from "../domain/recipe/recipe.errors.ts";

// A flow or step that came from no recipe, which moving the SDK leaves as it
// is, with what it imports that this chernabog's SDK doesn't have, if anything.
export const UpgradeLeft = Schema.Struct({
  file: Schema.String,
  missingImports: Schema.Array(Schema.String),
});

export class RepoUpgraded extends Schema.Class<RepoUpgraded, { readonly brand: "RepoUpgraded" }>(
  "RepoUpgraded",
)({
  // The @chernabog/sdk version it moved the repo to.
  sdkVersion: Schema.String,
  // Whether package.json's pins moved.
  pinned: Schema.Boolean,
  left: Schema.Array(UpgradeLeft),
  // Whether .chernabog/ has a recipe package installed to tell its copies by.
  packagesInstalled: Schema.Boolean,
}) {}

// Moves the repo at `root` onto the core this binary provides and the SDK
// released with it, in its working tree, committing nothing (.chernabog/ is a
// person's to merge): package.json's dev pins move to this binary's core and
// effect, and its SDK to the released one, unless it lists a newer one. Its
// copied recipes move with UpdateRecipesCommand, which the command runs next.
// Flows and steps from no recipe are left, each with what it imports straight
// from core that this core doesn't have. A .chernabog/ typed against a newer
// core than this binary provides is refused, rather than moved back.
export const UpgradeRepoCommand = Command.make("UpgradeRepoCommand", {
  payload: { root: Schema.String },
  success: RepoUpgraded,
  failure: Schema.Union([RecipeFilesFailed, ScaffoldRefused]),
});

export type UpgradeRepoPayload = Command.Payload<typeof UpgradeRepoCommand>;
