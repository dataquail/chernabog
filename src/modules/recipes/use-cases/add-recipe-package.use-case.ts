import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { RecipeFilesFailed, RecipePackageUnavailable } from "../domain/recipe/recipe.errors.ts";
import { SDK_PACKAGE } from "../domain/recipe/recipe-package.value-object.ts";
import {
  decodeRepoManifest,
  dependencyKind,
  sdkVersionOf,
} from "../domain/recipe/repo-manifest.value-object.ts";
import { RecipePackageAdded } from "./recipe.result.ts";

// Makes sure the repo at `root` has a recipe package installed in its
// .chernabog/, to copy recipes from: one it declares already is installed
// as it's declared; otherwise it's added as a dev dependency, at the newest
// version whose SDK range includes the repo's SDK pin.
export const addRecipePackageUseCase = Effect.fn("addRecipePackageUseCase")(function* (
  root: string,
  name: string,
) {
  const dir = yield* ChernabogDirClient;
  const packages = yield* RecipePackagesClient;

  const text = yield* Effect.fromOption(yield* dir.read(root, ".chernabog/package.json")).pipe(
    Effect.mapError(
      () =>
        new RecipeFilesFailed({ message: ".chernabog/ has no package.json; run chernabog init" }),
    ),
  );

  const manifest = yield* Effect.fromResult(decodeRepoManifest(text));

  if (Option.isSome(dependencyKind(manifest, name))) {
    yield* packages.restore(root);

    const installed = Arr.findFirst(
      yield* packages.installed(root),
      (found) => found.name === name,
    );

    return RecipePackageAdded.make({
      package: name,
      version: Option.getOrElse(
        Option.map(installed, (found) => found.version),
        () => "",
      ),
      change: "present",
    });
  }

  const sdk = yield* Effect.fromOption(sdkVersionOf(manifest)).pipe(
    Effect.mapError(
      () =>
        new RecipeFilesFailed({
          message: `.chernabog/package.json doesn't pin ${SDK_PACKAGE}; run chernabog recipes upgrade`,
        }),
    ),
  );

  const newest = yield* packages.newestFor(root, name, sdk).pipe(
    Effect.mapError(
      (error) =>
        new RecipePackageUnavailable({
          package: name,
          message: `couldn't find which version of ${name} to install: ${error.message}\nInstall it in .chernabog/ with bun add -d ${name} once you can reach its registry.`,
        }),
    ),
  );

  const version = yield* Effect.fromOption(newest).pipe(
    Effect.mapError(
      () =>
        new RecipePackageUnavailable({
          package: name,
          message: `no version of ${name} supports ${SDK_PACKAGE} ${sdk}`,
        }),
    ),
  );

  yield* packages.install(root, name, version, "devDependencies").pipe(
    Effect.mapError(
      (error) =>
        new RecipePackageUnavailable({
          package: name,
          message: `${error.message}\nInstall ${name} in .chernabog/ with bun add -d ${name} once you can reach its registry.`,
        }),
    ),
  );

  return RecipePackageAdded.make({ package: name, version, change: "added" });
});
