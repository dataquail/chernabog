// Recipes: complete flows, written out from the SDK's blocks, that a person
// chooses to bake into a repo's .chernabog/. None is installed unless chosen,
// and once baked, a recipe is the repo's own code: chernabog never rewrites it.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { ConfigError } from "./config.ts";
import { Exec } from "./Exec.ts";
import { Asker, type Choice } from "./interface/cli/asker.prompt.ts";
import { RECIPE_FILES } from "./templates.ts";

type RecipeFile = keyof typeof RECIPE_FILES;

export type Recipe = {
  readonly name: string;
  // One line, for the list init shows.
  readonly description: string;
  // Its flow, flows/<name>.ts, first; then the prompts it renders.
  readonly files: Arr.NonEmptyReadonlyArray<RecipeFile>;
};

export const RECIPES_DOCS = "https://dataquail.github.io/chernabog/recipes/";

export const RECIPES: ReadonlyArray<Recipe> = [
  {
    name: "implement",
    description:
      "Implements the oldest auto:eligible or auto:ship issue unattended, and asks a reviewer from the pool once its pull request is green",
    files: ["flows/implement.ts", "prompts/implement.md"],
  },
  {
    name: "review",
    description:
      "Reviews a pull request whose review is requested of the persona; an approval merges an auto:ship pull request",
    files: ["flows/review.ts", "prompts/review.md"],
  },
  {
    name: "re-review",
    description:
      "Reviews again when asked, in its own review session; approves, or hands the pull request to a person",
    files: ["flows/re-review.ts", "prompts/review.md"],
  },
  {
    name: "address-review",
    description:
      "Answers a review that requests changes on the persona's own pull request, in the session that wrote it",
    files: ["flows/address-review.ts"],
  },
  {
    name: "human-initiated",
    description:
      "The hybrid path: chernabog start <issue> opens a session with a person, then opens the pull request and asks for a review",
    files: ["flows/human-initiated.ts"],
  },
];

export const docsOf = (recipe: Recipe) => `${RECIPES_DOCS}${recipe.name}/`;

export const flowFileOf = (recipe: Recipe) => recipe.files[0];

const listed = (names: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(names.join(", "), (text) => text.length > 0),
    () => "none",
  );

export const recipeNamed = (name: string) =>
  Effect.fromOption(Arr.findFirst(RECIPES, (recipe) => recipe.name === name)).pipe(
    Effect.mapError(
      () =>
        new ConfigError({
          message: `no recipe named ${name} (there are: ${listed(RECIPES.map((recipe) => recipe.name))})`,
        }),
    ),
  );

// The recipes whose flow file the repo has, under its own name.
export const installedRecipes = (repoPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed: Array<Recipe> = [];

    for (const recipe of RECIPES) {
      if (yield* fs.exists(`${repoPath}/.chernabog/${flowFileOf(recipe)}`)) {
        installed.push(recipe);
      }
    }

    return installed;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: error.message })),
    ),
  );

// Writes each recipe's files into .chernabog/, never overwriting one that is
// there: a flow of that name is the repo's own, and a prompt another recipe
// brought is shared. Says what it wrote and what it kept.
export const installRecipes = (repoPath: string, recipes: ReadonlyArray<Recipe>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines: Array<string> = [];

    for (const recipe of recipes) {
      for (const file of recipe.files) {
        const path = `${repoPath}/.chernabog/${file}`;

        if (yield* fs.exists(path)) {
          if (file === flowFileOf(recipe)) {
            lines.push(`kept .chernabog/${file}, which is already there`);
          }

          continue;
        }

        yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        yield* fs.writeFileString(path, RECIPE_FILES[file]);
        lines.push(`wrote .chernabog/${file} (${recipe.name} recipe)`);
      }
    }

    return lines;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: error.message })),
    ),
  );

const choiceOf = (recipe: Recipe): Choice => ({
  title: recipe.name,
  value: recipe.name,
  description: `${recipe.description}. ${docsOf(recipe)}`,
});

// The recipes to bake: the ones named, else, in a terminal, the ones picked
// from those the repo doesn't have yet. Piped and unnamed, none.
export const chooseRecipes = (
  named: Option.Option<ReadonlyArray<string>>,
  installed: ReadonlyArray<Recipe>,
) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (Option.isSome(named)) {
      return yield* Effect.forEach(Arr.dedupe(named.value), recipeNamed);
    }

    const offered = RECIPES.filter((recipe) => !installed.includes(recipe));

    if (!asker.interactive || offered.length === 0) {
      return [];
    }

    const picked = yield* asker.pick(
      "Which recipes should this repo bake into .chernabog/flows/? (none is installed unless you pick it)",
      offered.map(choiceOf),
    );

    return offered.filter((recipe) => picked.includes(recipe.name));
  });

// One recipe file against the repo's copy, as a unified diff with the
// recipe's side first; empty when they match. git diff runs on copies in a
// scratch directory, so its headers read recipe/… and repo/….
const diffFile = (file: RecipeFile, theirs: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-recipe-diff-" });

      for (const [side, text] of [
        ["recipe", RECIPE_FILES[file]],
        ["repo", theirs],
      ] as const) {
        const path = `${scratch}/${side}/.chernabog/${file}`;
        yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        yield* fs.writeFileString(path, text);
      }

      const result = yield* (yield* Exec).run(
        "git",
        [
          "diff",
          "--no-index",
          "--no-color",
          "--no-prefix",
          "--",
          `recipe/.chernabog/${file}`,
          `repo/.chernabog/${file}`,
        ],
        { cwd: scratch },
      );

      // git diff --no-index exits 1 when the files differ, 0 when they don't.
      if (result.exitCode > 1) {
        return yield* new ConfigError({ message: `git diff: ${result.stderr.trim()}` });
      }

      return result.stdout.trimEnd();
    }),
  );

// How each of the repo's flows differs from the current version of the
// recipe it came from, the one it is named for, and the prompts that recipe
// renders; with names, only those recipes'. A flow from no recipe is named as
// such.
export const diffRecipes = (repoPath: string, named: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines: Array<string> = [];
    let recipes = yield* installedRecipes(repoPath);

    if (named.length > 0) {
      recipes = yield* Effect.forEach(Arr.dedupe(named), recipeNamed);
    }

    for (const recipe of recipes) {
      for (const file of recipe.files) {
        const path = `${repoPath}/.chernabog/${file}`;

        if (!(yield* fs.exists(path))) {
          lines.push(
            `.chernabog/${file}: not in the repo; chernabog recipes add ${recipe.name} bakes it`,
          );
          continue;
        }

        const diff = yield* diffFile(file, yield* fs.readFileString(path));

        if (diff.length === 0) {
          lines.push(`.chernabog/${file}: the same as the ${recipe.name} recipe`);
        } else {
          lines.push(
            `.chernabog/${file}: differs from the ${recipe.name} recipe (${docsOf(recipe)})`,
            diff,
          );
        }
      }
    }

    if (named.length === 0) {
      const directory = `${repoPath}/.chernabog/flows`;

      const flows = yield* Effect.map(
        Effect.orElseSucceed(fs.readDirectory(directory), (): ReadonlyArray<string> => []),
        (entries) =>
          Arr.sort(
            entries.filter((entry) => entry.endsWith(".ts")),
            Order.String,
          ),
      );

      for (const flow of flows.filter(
        (entry) => !recipes.some((recipe) => flowFileOf(recipe) === `flows/${entry}`),
      )) {
        lines.push(`.chernabog/flows/${flow}: from no recipe`);
      }
    }

    if (lines.length === 0) {
      lines.push(`.chernabog/flows/ has no flows; chernabog recipes list shows the recipes`);
    }

    return lines;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: error.message })),
    ),
  );
