// Recipe packages as a repo has them installed, read in the format the
// kernel defines (src/kernel/recipe-package.value-object.ts), and which of a
// package's versions supports the repo's SDK.

import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type RecipePackageManifest,
  SDK_PACKAGE,
} from "../../../../kernel/recipe-package.value-object.ts";
import { RecipeRoot } from "./recipe.root.ts";

export {
  formatRecipeRef,
  OFFICIAL_PACKAGE,
  parseRecipeRef,
  type RecipeManifest,
  RecipePackageManifest,
  type RecipeRef,
  SDK_PACKAGE,
} from "../../../../kernel/recipe-package.value-object.ts";

// A recipe package as installed: its version, the SDK range it declares, and
// its recipes, in the order its package.json lists them.
export type RecipePackage = {
  readonly name: string;
  readonly version: string;
  readonly sdkRange: Option.Option<string>;
  readonly recipes: ReadonlyArray<RecipeRoot>;
};

export const recipePackageOf = (manifest: RecipePackageManifest): RecipePackage => ({
  name: manifest.name,
  version: manifest.version,
  sdkRange: Record.get(manifest.peerDependencies ?? {}, SDK_PACKAGE),
  recipes: Record.toEntries(manifest.chernabog.recipes).map(([name, recipe]) =>
    RecipeRoot.make({
      package: manifest.name,
      version: manifest.version,
      name,
      description: recipe.description,
      flow: recipe.flow,
      prompts: recipe.prompts ?? [],
      stages: recipe.stages ?? [],
      docs: Option.fromUndefinedOr(recipe.docs),
    }),
  ),
});

// A package's released versions, newest first, without prereleases: the
// order a version supporting the repo's SDK is looked for in.
export const newestFirst = (versions: ReadonlyArray<string>) =>
  versions
    .filter((version) => !version.includes("-"))
    .toSorted((left, right) => Bun.semver.order(right, left));

// Whether a package declaring this SDK range supports flows written against `sdk`.
export const supportsSdk = (sdkRange: Option.Option<string>, sdk: string) =>
  Option.exists(sdkRange, (range) => Bun.semver.satisfies(sdk, range));
