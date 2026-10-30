import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { addRecipesUseCase } from "../../../modules/recipes/use-cases/add-recipes.use-case.ts";
import { diffRecipesUseCase } from "../../../modules/recipes/use-cases/diff-recipes.use-case.ts";
import { ejectRecipeUseCase } from "../../../modules/recipes/use-cases/eject-recipe.use-case.ts";
import { importRecipesUseCase } from "../../../modules/recipes/use-cases/import-recipes.use-case.ts";
import { listRecipesUseCase } from "../../../modules/recipes/use-cases/list-recipes.use-case.ts";
import {
  type RecipeEjected,
  type RecipeList,
  type RecipesAdded,
  type RecipesDiff,
  type RecipesImported,
  type RecipesUpdated,
  type RepoUpgraded,
} from "../../../modules/recipes/use-cases/recipe.result.ts";
import { scaffoldRepoUseCase } from "../../../modules/recipes/use-cases/scaffold-repo.use-case.ts";
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

const describeImported = (imported: RecipesImported) => [
  ...imported.flows.map(({ flow, keptFor, outcome, recipe, version }) => {
    switch (outcome) {
      case "imported": {
        return `imported ${flow} from the ${recipe} recipe, ${version} (flows.${flow}.from in .chernabog/config.yaml)`;
      }

      case "present": {
        return `${flow} already imports the ${recipe} recipe`;
      }

      case "kept": {
        return `kept ${flow}, which is ${Option.getOrElse(keptFor, () => "")} already; remove it, or name the flow you mean`;
      }
    }
  }),
  ...imported.dependencies.map(
    (name) => `.chernabog/package.json: ${name} in dependencies, which a snapshot installs`,
  ),
];

// Imports the recipes chosen into the repo at `root`, and the lines that say so.
const importRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const names = yield* chooseRecipes(root, named);

    if (names.length === 0) {
      return [];
    }

    return describeImported(yield* importRecipesUseCase(root, names));
  });

// Brings .chernabog/'s generated schemas up to date, now that its flows may
// declare other settings, and the lines that say what it rewrote.
export const refreshSchemas = (root: string) =>
  Effect.map(scaffoldRepoUseCase(root), (scaffolded) =>
    scaffolded.changes.flatMap(({ change, path }) =>
      Option.toArray(Option.liftPredicate(`wrote ${path} (updated)`, () => change === "updated")),
    ),
  );

const addOrImport = (
  importing: boolean,
  root: string,
  named: Option.Option<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const lines = yield* Effect.suspend(() => {
      if (importing) {
        return importRecipes(root, named);
      }

      return bakeRecipes(root, named);
    });

    if (lines.length === 0) {
      return lines;
    }

    return [...lines, ...(yield* refreshSchemas(root))];
  });

const recipesAdd = Command.make(
  "add",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription(
        `Recipes to copy: ${RECIPE_NAMING}. Asked in a terminal when none is named`,
      ),
      Argument.variadic(),
    ),
    importing: Flag.Boolean("import").pipe(
      Flag.withDescription(
        "Import the recipes instead of copying them: each runs from its package, which its team owns, under flows.<name>.from in config.yaml, and the package moves to dependencies",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ importing, names }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(Option.none());
      const named = Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty);

      const lines = yield* addOrImport(importing, root, named);

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
    "Copy recipes into this repo's .chernabog/, never overwriting a file it has, and record the version each came from; or, with --import, run them from their package",
  ),
);

const describeEjected = (ejected: RecipeEjected) => [
  ...ejected.files.map(({ file, outcome }) =>
    Option.getOrElse(
      Option.liftPredicate(
        `kept ${file}, which the repo has already and which overrode the package's`,
        () => outcome === "kept",
      ),
      () => `wrote ${file} (${ejected.recipe} recipe, ${ejected.version})`,
    ),
  ),
  `removed flows.${ejected.flow}.from from .chernabog/config.yaml; ${ejected.flow} now runs from .chernabog/flows/, under the same name and settings`,
];

const recipesEject = Command.make(
  "eject",
  {
    flow: Argument.String("flow").pipe(
      Argument.withDescription("The imported flow to copy in, by its name in config.yaml"),
    ),
  },
  ({ flow }) =>
    Effect.gen(function* () {
      yield* printLines(
        describeEjected(yield* ejectRecipeUseCase(yield* rootOf(Option.none()), flow)),
      );
      yield* Console.log(
        "The flow is the repo's own now: edit it as you like. chernabog recipes diff shows your edits, and chernabog recipes update merges the package's later changes into them. Commit and merge it to the base branch, then chernabog trust the repo.",
      );
    }),
).pipe(
  Command.withDescription(
    "Copy an imported flow, with its prompts and steps, into this repo's .chernabog/, so the repo owns it from now on",
  ),
);

// A repo whose recipes an earlier chernabog baked has no recipe package to
// compare its flows with, until init installs @chernabog/recipes.
const noPackageHint = (packagesInstalled: boolean, flows: boolean) =>
  Option.toArray(
    Option.liftPredicate(
      "No recipe package is installed in .chernabog/, so none of its flows can be told from a recipe. If an earlier chernabog baked them, chernabog init installs @chernabog/recipes, keeping every file, and then chernabog recipes diff compares them.",
      () => !packagesInstalled && flows,
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
  ]).concat(noPackageHint(diff.packagesInstalled, diff.files.length > 0));
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
    const root = yield* rootOf(Option.none());
    const updated = yield* updateRecipesUseCase(root, names, unrecorded);
    const lines = describeUpdate(updated);

    if (lines.length === 0) {
      return lines;
    }

    return [...lines, ...(yield* refreshSchemas(root))];
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
      `.chernabog/package.json: lists @chernabog/sdk ${upgraded.sdkVersion} and pins this chernabog's @chernabog/core and effect`,
      () => upgraded.pinned,
    ),
  ),
  ...upgraded.left.map(({ file, missingImports }) =>
    Option.match(Option.liftPredicate(missingImports, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => `${file}: from no recipe, left as it is; check it against the SDK's changes`,
      onSome: (missing) =>
        `${file}: from no recipe, left as it is; it imports what this chernabog's @chernabog/core doesn't have (${missing.join(", ")}), so move it by hand`,
    }),
  ),
  ...noPackageHint(upgraded.packagesInstalled, upgraded.left.length > 0),
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
    "Move this repo's .chernabog/ onto this chernabog's core and the SDK released with it: its pins, and its copied recipes to the newest versions for that SDK, in the working tree",
  ),
);

export const recipesCommand = Command.make("recipes", {}, () => Effect.void).pipe(
  Command.withDescription(
    "Complete flows from recipe packages, copied into a repo as code it then owns",
  ),
  Command.withSubcommands([
    recipesList,
    recipesAdd,
    recipesEject,
    recipesDiff,
    recipesUpdate,
    recipesUpgrade,
  ]),
);
