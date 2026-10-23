import * as Schema from "effect/Schema";

import { RECIPES } from "../domain/recipe/recipe-catalog.value-object.ts";

export { RECIPES_DOCS } from "../domain/recipe/recipe-catalog.value-object.ts";

// The recipes this chernabog offers, by name, for help text that lists them.
export const RECIPE_NAMES = RECIPES.map((recipe) => recipe.name);

// A recipe as a person chooses it: what it does, where it's documented, and
// whether the repo has it.
export const RecipeEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  docs: Schema.String,
  installed: Schema.Boolean,
});

export class RecipeList extends Schema.Class<RecipeList, { readonly brand: "RecipeList" }>(
  "RecipeList",
)({
  recipes: Schema.Array(RecipeEntry),
}) {}

// One file baking recipes touched: written, or kept because the repo has
// its own.
export const RecipeWrite = Schema.Struct({
  file: Schema.String,
  recipe: Schema.String,
  outcome: Schema.Literals(["wrote", "kept"]),
});

export class RecipesAdded extends Schema.Class<RecipesAdded, { readonly brand: "RecipesAdded" }>(
  "RecipesAdded",
)({
  files: Schema.Array(RecipeWrite),
}) {}

// How one of the repo's .chernabog/ files stands against the recipe it came
// from: missing, the same, or different (with the diff); or from no recipe.
export const RecipeDiffEntry = Schema.Struct({
  file: Schema.String,
  recipe: Schema.Option(Schema.String),
  docs: Schema.Option(Schema.String),
  state: Schema.Literals(["missing", "same", "differs", "unowned"]),
  diff: Schema.Option(Schema.String),
});

export class RecipesDiff extends Schema.Class<RecipesDiff, { readonly brand: "RecipesDiff" }>(
  "RecipesDiff",
)({
  files: Schema.Array(RecipeDiffEntry),
}) {}

// One file the scaffold changed: written, brought up to date, its pins moved,
// or, for .gitignore, the entries it gained.
export const ScaffoldChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["written", "updated", "pinned", "ignored"]),
  entries: Schema.Array(Schema.String),
});

export class Scaffolded extends Schema.Class<Scaffolded, { readonly brand: "Scaffolded" }>(
  "Scaffolded",
)({
  changes: Schema.Array(ScaffoldChange),
}) {}
