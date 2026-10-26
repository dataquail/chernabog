// The rules of recipes across the packages a repo has installed: which a
// person can name, which a repo has copied, and where each is documented.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";

import { RecipePackageMissing, UnknownRecipe } from "./recipe.errors.ts";
import { type RecipeRoot } from "./recipe.root.ts";
import {
  formatRecipeRef,
  OFFICIAL_PACKAGE,
  parseRecipeRef,
  type RecipePackage,
} from "./recipe-package.value-object.ts";
import { type CopiedRecord } from "./repo-manifest.value-object.ts";

const docsOf = (recipe: RecipeRoot) => recipe.docs;

// How a person names it: bare for the official package.
const refOf = (recipe: RecipeRoot) =>
  formatRecipeRef({ package: recipe.package, name: recipe.name });

// What it brings, by path under .chernabog/: its flow, then its prompts and steps.
const filesOf = (recipe: RecipeRoot): ReadonlyArray<string> => [
  recipe.flow,
  ...recipe.prompts,
  ...recipe.stages,
];

// The flow it brings, by which a repo is said to have copied it.
const flowFileOf = (recipe: RecipeRoot) => recipe.flow;

// The official package first, then the rest by name, so where two packages
// bring the same file the official one is matched.
const byOfficialThenName = Order.combine(
  Order.mapInput(Order.Boolean, (found: RecipePackage) => found.name !== OFFICIAL_PACKAGE),
  Order.mapInput(Order.String, (found: RecipePackage) => found.name),
);

const ordered = (packages: ReadonlyArray<RecipePackage>) => Arr.sort(packages, byOfficialThenName);

const recipesOf = (packages: ReadonlyArray<RecipePackage>) =>
  ordered(packages).flatMap((found) => found.recipes);

// The recipe a person names, as `<package>/<recipe>` or a bare name from the
// official package, among the installed packages.
const named = (packages: ReadonlyArray<RecipePackage>, text: string) => {
  const ref = parseRecipeRef(text);

  return Option.match(
    Arr.findFirst(packages, (found) => found.name === ref.package),
    {
      onNone: () =>
        Result.fail<RecipePackageMissing | UnknownRecipe>(
          new RecipePackageMissing({ package: ref.package }),
        ),
      onSome: (found) =>
        Result.fromOption(
          Arr.findFirst(found.recipes, (recipe) => recipe.name === ref.name),
          () =>
            new UnknownRecipe({
              recipe: text,
              known: recipesOf(packages).map(refOf),
            }),
        ),
    },
  );
};

// The recipes a person names, each once, in their order; refused whole for a
// name that isn't one, before anything is written.
const allNamed = (packages: ReadonlyArray<RecipePackage>, names: ReadonlyArray<string>) =>
  Result.all(Arr.dedupe(names).map((name) => named(packages, name)));

// The recipes a repo has copied: those whose flow file it has, each flow
// matched once.
const copiedIn = (packages: ReadonlyArray<RecipePackage>, has: (file: string) => boolean) =>
  Arr.dedupeWith(
    recipesOf(packages).filter((recipe) => has(flowFileOf(recipe))),
    (left, right) => left.flow === right.flow,
  );

// One file a repo copied from a recipe: where it is under .chernabog/, and
// where in the package it came from.
export type Copy = {
  readonly file: string;
  readonly packageFile: string;
  readonly recipe: RecipeRoot;
};

// Every file a repo copied from the installed recipes, each once: the files
// of the recipes whose flow it has, and the files recorded as copied, such as
// a flow ejected under another name. With `only`, just those recipes'.
const copiesIn = (
  packages: ReadonlyArray<RecipePackage>,
  records: Readonly<Record<string, CopiedRecord>>,
  has: (file: string) => boolean,
  only: Option.Option<ReadonlyArray<RecipeRoot>> = Option.none(),
): ReadonlyArray<Copy> => {
  const wanted = (recipe: RecipeRoot) =>
    Option.match(only, {
      onNone: () => true,
      onSome: (chosen) =>
        chosen.some((each) => each.package === recipe.package && each.name === recipe.name),
    });

  const byFlow = Option.match(only, {
    onNone: () => copiedIn(packages, has),
    onSome: (chosen) => chosen,
  }).flatMap((recipe) => filesOf(recipe).map((file) => ({ file, packageFile: file, recipe })));

  // A recorded flow counts while the repo has it; a deleted one isn't brought back.
  const byRecord = Object.entries(records)
    .filter(([file]) => !file.startsWith("flows/") || has(file))
    .flatMap(([file, record]) =>
      Option.toArray(
        Option.map(Result.getSuccess(named(packages, record.from)), (recipe): Copy => ({
          file,
          packageFile: Option.getOrElse(Option.fromUndefinedOr(record.file), () => file),
          recipe,
        })),
      ),
    );

  return Arr.dedupeWith(
    [...byFlow, ...byRecord].filter((copy) => wanted(copy.recipe)),
    (left, right) => left.file === right.file,
  );
};

// A recipe as `<package>/<recipe>`, however a person named it.
const fullRef = (text: string) => {
  const ref = parseRecipeRef(text);

  return `${ref.package}/${ref.name}`;
};

export const RecipeRootOps = {
  fullRef,
  copiesIn,
  docsOf,
  refOf,
  filesOf,
  flowFileOf,
  recipesOf,
  named,
  allNamed,
  copiedIn,
} as const;
