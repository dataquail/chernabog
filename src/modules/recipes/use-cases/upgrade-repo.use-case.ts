import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";

import { BundleClient } from "../domain/ports/clients/bundle.client.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { copiedOf, decodeRepoManifest } from "../domain/recipe/repo-manifest.value-object.ts";
import { RepoUpgraded } from "./recipe.result.ts";

type Left = (typeof RepoUpgraded.Type.left)[number];

const MODULE = /\.(?:ts|js|mts|mjs)$/;

// Moves the repo at `root` onto the SDK this binary runs, in its working tree,
// committing nothing (.chernabog/ is a person's to merge): package.json's pins
// move to this binary's SDK and effect. Its copied recipes move with
// updateRecipesUseCase, which the command runs next. Flows and steps from no
// recipe are left, each with what it imports that this SDK doesn't have. A
// .chernabog/ written against a newer SDK than this binary runs is refused,
// rather than moved back.
export const upgradeRepoUseCase = Effect.fn("upgradeRepoUseCase")(function* (root: string) {
  const dir = yield* ChernabogDirClient;
  const bundle = yield* BundleClient;
  const packages = yield* RecipePackagesClient;
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
  }

  const records = Option.getOrElse(
    Option.flatMap(manifest, (text) =>
      Option.map(Result.getSuccess(decodeRepoManifest(text)), copiedOf),
    ),
    () => ({}),
  );

  const flows = (yield* dir.list(root, ".chernabog/flows"))
    .filter((file) => MODULE.test(file))
    .map((file) => `flows/${file}`);

  // A package missing from node_modules only hides which flows are copies.
  const installed = yield* packages.restore(root).pipe(
    Effect.andThen(packages.installed(root)),
    Effect.orElseSucceed(() => []),
  );

  const copied = new Set([
    ...Object.keys(records),
    ...RecipeRootOps.copiedIn(installed, (file) => flows.includes(file)).flatMap(
      RecipeRootOps.filesOf,
    ),
  ]);

  const left: Array<Left> = [];

  const handWritten = [
    ...flows,
    ...(yield* dir.list(root, ".chernabog/stages"))
      .filter((file) => MODULE.test(file))
      .map((file) => `stages/${file}`),
  ].filter((file) => !copied.has(file) && !Record.has(records, file));

  for (const file of handWritten) {
    const path = `.chernabog/${file}`;
    const source = Option.getOrElse(yield* dir.read(root, path), () => "");

    left.push({ file: path, missingImports: bundle.missingImports(source) });
  }

  return RepoUpgraded.make({
    sdkVersion: bundle.sdkVersion,
    pinned: Option.isSome(pinned),
    left,
    packagesInstalled: installed.length > 0,
  });
});
