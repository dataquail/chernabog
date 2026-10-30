import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { type Unrecorded } from "../domain/recipe/copy-update.value-object.ts";
import {
  RecipeFilesFailed,
  RecipePackageMissing,
  RecipePackageUnavailable,
  UnknownRecipe,
} from "../domain/recipe/recipe.errors.ts";

export type { Unrecorded };

// A recipe package moved to the newest version for the repo's SDK.
export const PackageMove = Schema.Struct({
  name: Schema.String,
  from: Schema.String,
  to: Schema.String,
});

// What updating did to one copied file, brought to `to`:
// - written: the repo didn't have it (a file the recipe gained);
// - updated: unedited since it was copied, so replaced;
// - merged: edited here, with the recipe's changes merged in;
// - conflicted: merged, with conflict markers where both changed the same lines;
// - adopted: nothing recorded where it came from, so kept as it is and
//   recorded as from `to`, its differences being the repo's own edits;
// - replaced: nothing recorded, and replaced by the recipe (recipes upgrade).
export const UpdateChange = Schema.Struct({
  file: Schema.String,
  recipe: Schema.String,
  from: Schema.Option(Schema.String),
  to: Schema.String,
  change: Schema.Literals(["written", "updated", "merged", "conflicted", "adopted", "replaced"]),
});

export class RecipesUpdated extends Schema.Class<
  RecipesUpdated,
  { readonly brand: "RecipesUpdated" }
>("RecipesUpdated")({
  packages: Schema.Array(PackageMove),
  changes: Schema.Array(UpdateChange),
}) {}

// Brings the repo's copied recipes up to the newest version of their packages
// for the repo's SDK, in its working tree, committing nothing: each recipe
// package moves to the newest version whose SDK range includes the repo's
// pin, and each copied file takes that version's changes. A file unedited
// since it was copied is replaced; an edited one is merged, 3-way, from the
// version recorded for it, keeping the repo's edits and marking conflicts.
// With names, only those recipes'. A file with nothing recorded is adopted or
// replaced, as `unrecorded` says.
export const UpdateRecipesCommand = Command.make("UpdateRecipesCommand", {
  payload: {
    root: Schema.String,
    names: Schema.Array(Schema.String),
    unrecorded: Schema.Literals(["adopt", "replace"]),
  },
  success: RecipesUpdated,
  failure: Schema.Union([
    RecipeFilesFailed,
    RecipePackageMissing,
    RecipePackageUnavailable,
    UnknownRecipe,
  ]),
});

export type UpdateRecipesPayload = Command.Payload<typeof UpdateRecipesCommand>;
