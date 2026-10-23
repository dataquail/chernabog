// The rules of the recipe catalog: which a person can name, which a repo
// has, which it's offered, and where each is documented.

import * as Arr from "effect/Array";
import * as Result from "effect/Result";

import { UnknownRecipe } from "./recipe.errors.ts";
import { type RecipeRoot } from "./recipe.root.ts";
import { RECIPES, RECIPES_DOCS } from "./recipe-catalog.value-object.ts";

const docsOf = (recipe: RecipeRoot) => `${RECIPES_DOCS}${recipe.name}/`;

// The flow a recipe bakes, under its own name, by which a repo is said to have it.
const flowFileOf = (recipe: RecipeRoot) => recipe.files[0];

const named = (name: string) =>
  Result.fromOption(
    Arr.findFirst(RECIPES, (recipe) => recipe.name === name),
    () => new UnknownRecipe({ recipe: name, known: RECIPES.map((recipe) => recipe.name) }),
  );

// The recipes a person names, each once, in their order; refused whole for a
// name that isn't one, before anything is written.
const allNamed = (names: ReadonlyArray<string>) => Result.all(Arr.dedupe(names).map(named));

// The recipes a repo has: those whose flow file is there.
const installed = (has: (file: string) => boolean) =>
  RECIPES.filter((recipe) => has(flowFileOf(recipe)));

export const RecipeRootOps = { docsOf, flowFileOf, named, allNamed, installed } as const;
