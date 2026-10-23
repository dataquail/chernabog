import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BundleClient } from "../domain/ports/clients/bundle.client.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { TextDiffClient } from "../domain/ports/clients/text-diff.client.ts";
import { type RecipeRoot } from "../domain/recipe/recipe.root.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { RecipesDiff } from "./recipe.result.ts";

type Entry = (typeof RecipesDiff.Type.files)[number];

// How the repo's flows, and the prompts their recipes render, differ from
// this chernabog's recipes they're named for; with names, only those
// recipes'. Without, each flow from no recipe is listed as such.
export const diffRecipesUseCase = Effect.fn("diffRecipesUseCase")(function* (
  root: string,
  names: ReadonlyArray<string>,
) {
  const dir = yield* ChernabogDirClient;
  const bundle = yield* BundleClient;
  const differ = yield* TextDiffClient;

  const flows = (yield* dir.list(root, ".chernabog/flows")).filter((entry) =>
    entry.endsWith(".ts"),
  );

  const recipes: ReadonlyArray<RecipeRoot> = yield* Option.match(
    Option.liftPredicate(names, (named) => named.length > 0),
    {
      onSome: (named) => Effect.fromResult(RecipeRootOps.allNamed(named)),
      onNone: () =>
        Effect.succeed(
          RecipeRootOps.installed((file) => flows.includes(file.replace(/^flows\//, ""))),
        ),
    },
  );

  const files: Array<Entry> = [];

  for (const recipe of recipes) {
    const docs = Option.some(RecipeRootOps.docsOf(recipe));

    for (const file of recipe.files) {
      const path = `.chernabog/${file}`;
      const theirs = yield* dir.read(root, path);
      const owned = { file: path, recipe: Option.some(recipe.name), docs };

      if (Option.isNone(theirs)) {
        files.push({ ...owned, state: "missing", diff: Option.none() });
        continue;
      }

      const diff = yield* differ.diff(file, yield* bundle.recipeFile(file), theirs.value);

      files.push({
        ...owned,
        ...Option.match(
          Option.liftPredicate(diff, (found) => found.length > 0),
          {
            onNone: () => ({ state: "same" as const, diff: Option.none() }),
            onSome: (found) => ({ state: "differs" as const, diff: Option.some(found) }),
          },
        ),
      });
    }
  }

  if (names.length === 0) {
    for (const flow of flows.filter(
      (entry) => !recipes.some((recipe) => RecipeRootOps.flowFileOf(recipe) === `flows/${entry}`),
    )) {
      files.push({
        file: `.chernabog/flows/${flow}`,
        recipe: Option.none(),
        docs: Option.none(),
        state: "unowned",
        diff: Option.none(),
      });
    }
  }

  return RecipesDiff.make({ files });
});
