import * as Schema from "effect/Schema";

// The package init installs and a bare recipe name means.
export { OFFICIAL_PACKAGE } from "../domain/recipe/recipe-package.value-object.ts";

// A recipe as a person chooses it: which package and version it's from, what
// it does, where it's documented, and whether the repo copied or imports it.
export const RecipeEntry = Schema.Struct({
  // How a person names it: bare for @chernabog/recipes, else <package>/<recipe>.
  ref: Schema.String,
  package: Schema.String,
  version: Schema.String,
  description: Schema.String,
  docs: Schema.Option(Schema.String),
  state: Schema.Literals(["copied", "imported", "available"]),
});

export const InstalledPackage = Schema.Struct({ name: Schema.String, version: Schema.String });

export class RecipeList extends Schema.Class<RecipeList, { readonly brand: "RecipeList" }>(
  "RecipeList",
)({
  // The recipe packages .chernabog/ has installed.
  packages: Schema.Array(InstalledPackage),
  recipes: Schema.Array(RecipeEntry),
}) {}

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

// One file the scaffold changed: written, brought up to date, or, for
// .gitignore, the entries it gained.
export const ScaffoldChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["written", "updated", "ignored"]),
  entries: Schema.Array(Schema.String),
});

export class Scaffolded extends Schema.Class<Scaffolded, { readonly brand: "Scaffolded" }>(
  "Scaffolded",
)({
  changes: Schema.Array(ScaffoldChange),
}) {}

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
