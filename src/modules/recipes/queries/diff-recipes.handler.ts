import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { TextDiffClient } from "../domain/ports/clients/text-diff.client.ts";
import { type RecipeRoot } from "../domain/recipe/recipe.root.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { parseRecipeRef } from "../domain/recipe/recipe-package.value-object.ts";
import { copiedOf, decodeRepoManifest } from "../domain/recipe/repo-manifest.value-object.ts";
import { type DiffRecipesPayload, RecipesDiff } from "./diff-recipes.query.ts";

type Entry = (typeof RecipesDiff.Type.files)[number];

export const diffRecipesHandler = Effect.fn("diffRecipesHandler")(function* (
  query: DiffRecipesPayload,
) {
  const { names, root } = query;
  const dir = yield* ChernabogDirClient;
  const packages = yield* RecipePackagesClient;
  const differ = yield* TextDiffClient;

  yield* packages.restore(root);

  const installed = yield* packages.installed(root);

  const records = yield* Option.match(yield* dir.read(root, ".chernabog/package.json"), {
    onNone: () => Effect.succeed({}),
    onSome: (text) => Effect.map(Effect.fromResult(decodeRepoManifest(text)), copiedOf),
  });

  const flows = (yield* dir.list(root, ".chernabog/flows")).map((entry) => `flows/${entry}`);

  const named = yield* Option.match(
    Option.liftPredicate(names, (some) => some.length > 0),
    {
      onSome: (some) => Effect.asSome(Effect.fromResult(RecipeRootOps.allNamed(installed, some))),
      onNone: () => Effect.succeed(Option.none<ReadonlyArray<RecipeRoot>>()),
    },
  );

  const copies = RecipeRootOps.copiesIn(installed, records, (file) => flows.includes(file), named);
  const files: Array<Entry> = [];

  for (const { file, packageFile, recipe } of copies) {
    const path = `.chernabog/${file}`;
    const theirs = yield* dir.read(root, path);

    // A prompt two recipes share is recorded once, under either.
    const record = Option.filter(
      Record.get(records, file),
      (found) => parseRecipeRef(found.from).package === recipe.package,
    );

    const version = Option.match(record, {
      onNone: () => recipe.version,
      onSome: (found) => found.version,
    });

    const owned = {
      file: path,
      recipe: Option.some(RecipeRootOps.refOf(recipe)),
      version: Option.some(`${recipe.package}@${version}`),
      recorded: Option.isSome(record),
      docs: RecipeRootOps.docsOf(recipe),
    };

    if (Option.isNone(theirs)) {
      files.push({ ...owned, state: "missing", diff: Option.none() });
      continue;
    }

    const original = yield* Option.match(record, {
      onNone: () => packages.file(root, recipe.package, packageFile),
      onSome: (found) => packages.fileAt(root, recipe.package, found.version, packageFile),
    });

    const diff = yield* differ.diff(
      file,
      Option.getOrElse(original, () => ""),
      theirs.value,
    );

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

  if (names.length === 0) {
    for (const flow of flows.filter(
      (entry) => /\.(?:ts|js|mts|mjs)$/.test(entry) && !copies.some((copy) => copy.file === entry),
    )) {
      files.push({
        file: `.chernabog/${flow}`,
        recipe: Option.none(),
        version: Option.none(),
        recorded: false,
        docs: Option.none(),
        state: "unowned",
        diff: Option.none(),
      });
    }
  }

  return RecipesDiff.make({ files, packagesInstalled: installed.length > 0 });
});
