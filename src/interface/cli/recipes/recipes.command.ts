import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { addRecipesUseCase } from "../../../modules/recipes/use-cases/add-recipes.use-case.ts";
import { diffRecipesUseCase } from "../../../modules/recipes/use-cases/diff-recipes.use-case.ts";
import { listRecipesUseCase } from "../../../modules/recipes/use-cases/list-recipes.use-case.ts";
import {
  RECIPE_NAMES,
  type RecipesAdded,
  type RecipesDiff,
  type RepoUpgraded,
} from "../../../modules/recipes/use-cases/recipe.result.ts";
import { upgradeRepoUseCase } from "../../../modules/recipes/use-cases/upgrade-repo.use-case.ts";
import { VERSION } from "../../../platform/version.ts";
import { Asker, type Choice } from "../asker.prompt.ts";
import { printLines } from "../cli.output.ts";
import { rootOf } from "../enrollment/enroll.command.ts";
import { listFlag } from "../list.arguments.ts";

export const RECIPES_LIST = RECIPE_NAMES.join(", ");

export const recipesFlag = listFlag(
  "recipes",
  `Recipes to bake into .chernabog/flows/, comma-separated: ${RECIPES_LIST}. Asked in a terminal; none otherwise`,
);

// The recipes to bake: the ones named, else, in a terminal, the ones a person
// picks from those the repo doesn't have yet. Piped and unnamed, none.
const chooseRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (Option.isSome(named)) {
      return named.value;
    }

    const offered = (yield* listRecipesUseCase(root)).recipes.filter((recipe) => !recipe.installed);

    if (!asker.interactive || offered.length === 0) {
      return [];
    }

    return yield* asker.pick(
      "Which recipes should this repo bake into .chernabog/flows/? (none is installed unless you pick it)",
      offered.map((recipe): Choice => ({
        title: recipe.name,
        value: recipe.name,
        description: `${recipe.description}. ${recipe.docs}`,
      })),
    );
  });

const describeAdded = (added: RecipesAdded) =>
  added.files.map(({ file, outcome, recipe }) =>
    Option.getOrElse(
      Option.liftPredicate(`kept ${file}, which is already there`, () => outcome === "kept"),
      () => `wrote ${file} (${recipe} recipe)`,
    ),
  );

// Bakes the recipes chosen into the repo at `root`, and the lines that say
// what it wrote.
export const bakeRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const names = yield* chooseRecipes(root, named);

    return describeAdded(yield* addRecipesUseCase(root, names));
  });

const recipesList = Command.make(
  "list",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const { recipes } = yield* listRecipesUseCase(yield* rootOf(path));

      yield* printLines(
        recipes.flatMap((recipe) => [
          `${Option.getOrElse(
            Option.liftPredicate("✓", () => recipe.installed),
            () => " ",
          )} ${recipe.name}: ${recipe.description}`,
          `    ${recipe.docs}`,
        ]),
      );
    }),
).pipe(Command.withDescription("List the recipes, with a check by each one the repo has"));

const recipesAdd = Command.make(
  "add",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription(
        `Recipes to bake: ${RECIPES_LIST}. Asked in a terminal when none is named`,
      ),
      Argument.variadic(),
    ),
  },
  ({ names }) =>
    Effect.gen(function* () {
      const lines = yield* bakeRecipes(
        yield* rootOf(Option.none()),
        Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty),
      );

      if (lines.length === 0) {
        return yield* Console.log("Nothing added");
      }

      yield* printLines(lines);
      yield* Console.log(
        "Next: commit and merge them to the base branch, chernabog trust the repo, and chernabog enroll here to choose which personas run them.",
      );
    }),
).pipe(
  Command.withDescription(
    "Bake recipes into this repo's .chernabog/flows/, never overwriting a flow it has",
  ),
);

const describeDiff = (diff: RecipesDiff) => {
  const lines = diff.files.flatMap(({ docs, file, recipe, state, ...entry }) => {
    const name = Option.getOrElse(recipe, () => "");

    switch (state) {
      case "missing": {
        return [`${file}: not in the repo; chernabog recipes add ${name} bakes it`];
      }

      case "same": {
        return [`${file}: the same as the ${name} recipe`];
      }

      case "differs": {
        return [
          `${file}: differs from the ${name} recipe (${Option.getOrElse(docs, () => "")})`,
          ...Option.toArray(entry.diff),
        ];
      }

      case "unowned": {
        return [`${file}: from no recipe`];
      }
    }
  });

  return Option.getOrElse(Option.liftPredicate(lines, Arr.isReadonlyArrayNonEmpty), () => [
    ".chernabog/flows/ has no flows; chernabog recipes list shows the recipes",
  ]);
};

// How the repo at `root` differs from the recipes, for a person.
export const diffLines = (root: string, names: ReadonlyArray<string>) =>
  diffRecipesUseCase(root, names).pipe(Effect.map(describeDiff));

const recipesDiff = Command.make(
  "diff",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription("Recipes to compare; every one the repo has when none is named"),
      Argument.variadic(),
    ),
  },
  ({ names }) =>
    Effect.gen(function* () {
      yield* Console.log(`Against the recipes of chernabog ${VERSION}:`);
      yield* printLines(yield* diffLines(yield* rootOf(Option.none()), names));
    }),
).pipe(
  Command.withDescription(
    "Show how this repo's flows differ from the current versions of the recipes they came from",
  ),
);

const describeUpgrade = (upgraded: RepoUpgraded) => [
  ...upgraded.changes.map(({ change, file, recipe }) => {
    const name = Option.getOrElse(recipe, () => "");

    switch (change) {
      case "pinned": {
        return `${file}: pins @chernabog/sdk ${upgraded.sdkVersion} and this chernabog's effect`;
      }

      case "written": {
        return `${file}: written from the ${name} recipe`;
      }

      case "replaced": {
        return `${file}: replaced by the current ${name} recipe; review the diff and re-apply any edits of your own`;
      }
    }
  }),
  ...upgraded.left.map(({ file, missingImports }) =>
    Option.match(Option.liftPredicate(missingImports, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => `${file}: from no recipe, left as it is; check it against the SDK's changes`,
      onSome: (missing) =>
        `${file}: from no recipe, left as it is; it imports what @chernabog/sdk ${upgraded.sdkVersion} doesn't have (${missing.join(", ")}), so move it by hand`,
    }),
  ),
];

const recipesUpgrade = Command.make("upgrade", {}, () =>
  Effect.gen(function* () {
    const upgraded = yield* upgradeRepoUseCase(yield* rootOf(Option.none()));

    if (upgraded.changes.length === 0 && upgraded.left.length === 0) {
      return yield* Console.log(`.chernabog/ is already on chernabog ${VERSION}; nothing changed`);
    }

    yield* printLines(describeUpgrade(upgraded));
    yield* Console.log(
      "Nothing is committed. Review the changes (git diff .chernabog/), reinstall in .chernabog/ for your editor, then commit and merge them to the base branch and chernabog trust the repo.",
    );
  }),
).pipe(
  Command.withDescription(
    "Move this repo's .chernabog/ onto this chernabog: its SDK pins, and its recipe flows to the current recipes, in the working tree",
  ),
);

export const recipesCommand = Command.make("recipes", {}, () => Effect.void).pipe(
  Command.withDescription("Complete flows to bake into a repo, as code it then owns"),
  Command.withSubcommands([recipesList, recipesAdd, recipesDiff, recipesUpgrade]),
);
