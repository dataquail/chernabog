import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RecipeFilesFailed, RecipePackageUnavailable } from "../domain/recipe/recipe.errors.ts";

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

// The recipes of every recipe package the repo at `root` has installed in its
// .chernabog/, each with whether the repo copied it or imports it: what a
// person chooses which to copy or import from.
export const ListRecipesQuery = Query.make("ListRecipesQuery", {
  payload: { root: Schema.String },
  success: RecipeList,
  failure: Schema.Union([RecipeFilesFailed, RecipePackageUnavailable]),
});

export type ListRecipesPayload = Query.Payload<typeof ListRecipesQuery>;
