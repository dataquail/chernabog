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
  type RecipeList,
  type RecipesAdded,
  type RecipesDiff,
  type RecipesUpdated,
  type RepoUpgraded,
} from "../../../modules/recipes/use-cases/recipe.result.ts";
import {
  type Unrecorded,
  updateRecipesUseCase,
} from "../../../modules/recipes/use-cases/update-recipes.use-case.ts";
import { upgradeRepoUseCase } from "../../../modules/recipes/use-cases/upgrade-repo.use-case.ts";
import { VERSION } from "../../../platform/version.ts";
import { Asker, type Choice } from "../asker.prompt.ts";
import { printLines } from "../cli.output.ts";
import { rootOf } from "../enrollment/enroll.command.ts";
import { listFlag } from "../list.arguments.ts";

// How a person names a recipe, for help text.
export const RECIPE_NAMING =
  "a bare name, such as review, from @chernabog/recipes, or <package>/<recipe> from another recipe package installed in .chernabog/";

export const recipesFlag = listFlag(
  "recipes",
  `Recipes to copy into .chernabog/, comma-separated: ${RECIPE_NAMING} (chernabog recipes list names them). Asked in a terminal; none otherwise`,
);

// The recipes to bake: the ones named, else, in a terminal, the ones a person
// picks from those the repo doesn't have yet. Piped and unnamed, none.
const chooseRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (Option.isSome(named)) {
      return named.value;
    }

    if (!asker.interactive) {
      return [];
    }

    const offered = (yield* listRecipesUseCase(root)).recipes.filter(
      (recipe) => recipe.state === "available",
    );

    if (offered.length === 0) {
      return [];
    }

    return yield* asker.pick(
      "Which recipes should this repo copy into .chernabog/? (none is added unless you pick it)",
      offered.map((recipe): Choice => ({
        title: recipe.ref,
        value: recipe.ref,
        description: [recipe.description, ...Option.toArray(recipe.docs)].join(". "),
      })),
    );
  });

const describeAdded = (added: RecipesAdded) =>
  added.files.map(({ file, outcome, recipe, version }) =>
    Option.getOrElse(
      Option.liftPredicate(`kept ${file}, which is already there`, () => outcome === "kept"),
      () => `wrote ${file} (${recipe} recipe, ${version})`,
    ),
  );

// Copies the recipes chosen into the repo at `root`, and the lines that say
// what it wrote.
export const bakeRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const names = yield* chooseRecipes(root, named);

    return describeAdded(yield* addRecipesUseCase(root, names));
  });

const MARKS = { copied: "✓", imported: "→", available: " " } as const;

const describeList = (list: RecipeList) =>
  Option.match(Option.liftPredicate(list.packages, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => [
      "No recipe packages are installed in .chernabog/. chernabog init adds @chernabog/recipes; add another with bun add -d <package> in .chernabog/.",
    ],
    onSome: (packages) =>
      packages.flatMap((found) => [
        `${found.name} ${found.version}:`,
        ...list.recipes
          .filter((recipe) => recipe.package === found.name)
          .flatMap((recipe) => [
            `${MARKS[recipe.state]} ${recipe.ref}: ${recipe.description}`,
            ...Option.toArray(Option.map(recipe.docs, (docs) => `    ${docs}`)),
          ]),
      ]),
  });

const recipesList = Command.make(
  "list",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      yield* printLines(describeList(yield* listRecipesUseCase(yield* rootOf(path))));
    }),
).pipe(
  Command.withDescription(
    "List the recipes of each recipe package installed in .chernabog/, with a check by each one the repo has copied",
  ),
);

const recipesAdd = Command.make(
  "add",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription(
        `Recipes to copy: ${RECIPE_NAMING}. Asked in a terminal when none is named`,
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
    "Copy recipes into this repo's .chernabog/, never overwriting a file it has, and record the version each came from",
  ),
);

const describeDiff = (diff: RecipesDiff) => {
  const lines = diff.files.flatMap(({ docs, file, recipe, recorded, state, version, ...entry }) => {
    const name = Option.getOrElse(recipe, () => "");
    const against = Option.getOrElse(version, () => "");

    const unrecorded = Option.getOrElse(
      Option.liftPredicate(
        ", the version installed, since nothing records which it came from",
        () => !recorded,
      ),
      () => "",
    );

    switch (state) {
      case "missing": {
        return [`${file}: not in the repo; chernabog recipes add ${name} copies it`];
      }

      case "same": {
        return [`${file}: the same as the ${name} recipe in ${against}${unrecorded}`];
      }

      case "differs": {
        return [
          `${file}: differs from the ${name} recipe in ${against}${unrecorded}${Option.getOrElse(
            Option.map(docs, (found) => ` (${found})`),
            () => "",
          )}`,
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

// How the repo at `root` differs from the recipes it copied, for a person.
export const diffLines = (root: string, names: ReadonlyArray<string>) =>
  diffRecipesUseCase(root, names).pipe(Effect.map(describeDiff));

const recipeNames = (verb: string, none: string) =>
  Argument.String("recipe").pipe(
    Argument.withDescription(`Recipes to ${verb}; ${none} when none is named`),
    Argument.variadic(),
  );

const recipesDiff = Command.make(
  "diff",
  { names: recipeNames("compare", "every one the repo has copied") },
  ({ names }) =>
    Effect.gen(function* () {
      yield* printLines(yield* diffLines(yield* rootOf(Option.none()), names));
    }),
).pipe(
  Command.withDescription(
    "Show how this repo's copied flows differ from the version of the recipe each was copied from: the repo's own edits",
  ),
);

const UPDATED: Record<RecipesUpdated["changes"][number]["change"], string> = {
  written: "written from",
  updated: "updated to",
  merged: "merged your edits with",
  conflicted: "merged with conflicts, marked in the file; resolve them, keeping what you need of",
  adopted: "kept as it is, since nothing recorded which version it came from, and recorded as from",
  replaced:
    "replaced, since nothing recorded which version it came from; review the diff and re-apply any edits of your own, from",
};

const describeUpdate = (updated: RecipesUpdated) => [
  ...updated.packages.map(
    ({ from, name, to }) => `.chernabog/package.json: ${name} ${from} -> ${to}`,
  ),
  ...updated.changes.map(
    ({ change, file, recipe, to }) => `${file}: ${UPDATED[change]} the ${recipe} recipe in ${to}`,
  ),
];

const NOTHING_COMMITTED =
  "Nothing is committed. Review the changes (git diff .chernabog/), then commit and merge them to the base branch and chernabog trust the repo.";

const updateHere = (names: ReadonlyArray<string>, unrecorded: Unrecorded) =>
  Effect.gen(function* () {
    const updated = yield* updateRecipesUseCase(yield* rootOf(Option.none()), names, unrecorded);

    return describeUpdate(updated);
  });

const recipesUpdate = Command.make(
  "update",
  { names: recipeNames("update", "every one the repo has copied") },
  ({ names }) =>
    Effect.gen(function* () {
      const lines = yield* updateHere(names, "adopt");

      if (lines.length === 0) {
        return yield* Console.log("The copied recipes are up to date; nothing changed");
      }

      yield* printLines(lines);
      yield* Console.log(NOTHING_COMMITTED);
    }),
).pipe(
  Command.withDescription(
    "Bring this repo's copied recipes up to the newest version of their packages for its SDK, merging the recipes' changes into your edits, in the working tree",
  ),
);

const describeUpgrade = (upgraded: RepoUpgraded) => [
  ...Option.toArray(
    Option.liftPredicate(
      `.chernabog/package.json: pins @chernabog/sdk ${upgraded.sdkVersion} and this chernabog's effect`,
      () => upgraded.pinned,
    ),
  ),
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
    const lines = [...describeUpgrade(upgraded), ...(yield* updateHere([], "replace"))];

    if (lines.length === 0) {
      return yield* Console.log(`.chernabog/ is already on chernabog ${VERSION}; nothing changed`);
    }

    yield* printLines(lines);
    yield* Console.log(
      "Nothing is committed. Review the changes (git diff .chernabog/), then commit and merge them to the base branch and chernabog trust the repo.",
    );
  }),
).pipe(
  Command.withDescription(
    "Move this repo's .chernabog/ onto this chernabog's SDK: its pins, and its copied recipes to the newest versions for that SDK, in the working tree",
  ),
);

export const recipesCommand = Command.make("recipes", {}, () => Effect.void).pipe(
  Command.withDescription(
    "Complete flows from recipe packages, copied into a repo as code it then owns",
  ),
  Command.withSubcommands([recipesList, recipesAdd, recipesDiff, recipesUpdate, recipesUpgrade]),
);
