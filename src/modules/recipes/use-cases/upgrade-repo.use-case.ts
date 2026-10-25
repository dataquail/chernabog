import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BundleClient } from "../domain/ports/clients/bundle.client.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { RepoUpgraded } from "./recipe.result.ts";

type Change = (typeof RepoUpgraded.Type.changes)[number];

type Left = (typeof RepoUpgraded.Type.left)[number];

const MODULE = /\.(?:ts|js|mts|mjs)$/;

// Moves the repo at `root` onto the SDK this binary runs, in its working tree,
// committing nothing (.chernabog/ is a person's to merge): package.json's pins
// move to this binary's SDK and effect, and the flows baked from recipes, and
// the files their recipes render, become the current recipes. A recipe's file
// that differs may hold a person's own edits, so it's replaced and said, for
// them to review in the diff. Flows and steps from no recipe are left, each
// with what it imports that this SDK doesn't have. A .chernabog/ written
// against a newer SDK than this binary runs is refused, rather than moved back.
export const upgradeRepoUseCase = Effect.fn("upgradeRepoUseCase")(function* (root: string) {
  const dir = yield* ChernabogDirClient;
  const bundle = yield* BundleClient;
  const changes: Array<Change> = [];
  const manifestPath = ".chernabog/package.json";
  const manifest = yield* dir.read(root, manifestPath);

  for (const found of Option.toArray(manifest)) {
    yield* bundle.refuseNewer(found);
  }

  const pinned = yield* Option.match(manifest, {
    onNone: () => Effect.map(bundle.scaffold, (scaffold) => Option.some(scaffold.manifest)),
    onSome: bundle.pinned,
  });

  for (const text of Option.toArray(pinned)) {
    yield* dir.write(root, manifestPath, text);
    changes.push({ file: manifestPath, recipe: Option.none(), change: "pinned" });
  }

  const flows = (yield* dir.list(root, ".chernabog/flows")).filter((file) => MODULE.test(file));
  const recipes = RecipeRootOps.installed((file) => flows.includes(file.replace(/^flows\//, "")));
  const moved = new Set<string>();

  for (const recipe of recipes) {
    for (const file of recipe.files.filter((each) => !moved.has(each))) {
      moved.add(file);

      const path = `.chernabog/${file}`;
      const current = yield* bundle.recipeFile(file);
      const theirs = yield* dir.read(root, path);

      if (Option.contains(theirs, current)) {
        continue;
      }

      yield* dir.write(root, path, current);
      changes.push({
        file: path,
        recipe: Option.some(recipe.name),
        change: Option.match(theirs, {
          onNone: () => "written" as const,
          onSome: () => "replaced" as const,
        }),
      });
    }
  }

  const left: Array<Left> = [];

  const handWritten = [
    ...flows.map((file) => `flows/${file}`),
    ...(yield* dir.list(root, ".chernabog/stages"))
      .filter((file) => MODULE.test(file))
      .map((file) => `stages/${file}`),
  ].filter((file) => !moved.has(file));

  for (const file of handWritten) {
    const path = `.chernabog/${file}`;
    const source = Option.getOrElse(yield* dir.read(root, path), () => "");

    left.push({ file: path, missingImports: bundle.missingImports(source) });
  }

  return RepoUpgraded.make({ sdkVersion: bundle.sdkVersion, changes, left });
});
