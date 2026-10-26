import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import {
  type RecipeFilesFailed,
  type RecipePackageUnavailable,
} from "../../recipe/recipe.errors.ts";
import { type RecipePackage } from "../../recipe/recipe-package.value-object.ts";
import { type DependencyKind } from "../../recipe/repo-manifest.value-object.ts";

// The recipe packages of the checkout at `root`, which bun installs into its
// .chernabog/ from .chernabog/package.json, with the registries and auth its
// .npmrc names.
export type RecipePackagesClientService = {
  // Installs what .chernabog/package.json declares, when any of it is missing
  // from node_modules, as in a fresh clone.
  readonly restore: (root: string) => Effect.Effect<void, RecipePackageUnavailable>;
  // The recipe packages .chernabog/package.json declares, as installed.
  readonly installed: (
    root: string,
  ) => Effect.Effect<ReadonlyArray<RecipePackage>, RecipeFilesFailed>;
  // A file of an installed package, by path in it.
  readonly file: (
    root: string,
    name: string,
    path: string,
  ) => Effect.Effect<Option.Option<string>, RecipeFilesFailed>;
  // A file of a package at another version than the one installed, such as
  // the one a copied file came from; none when that version hasn't the file.
  readonly fileAt: (
    root: string,
    name: string,
    version: string,
    path: string,
  ) => Effect.Effect<Option.Option<string>, RecipePackageUnavailable>;
  // The newest released version of a package whose @chernabog/sdk peer range
  // includes `sdk`; none when no version does.
  readonly newestFor: (
    root: string,
    name: string,
    sdk: string,
  ) => Effect.Effect<Option.Option<string>, RecipePackageUnavailable>;
  // Installs a package at exactly `version`, declared in `kind`, updating the
  // lockfile.
  readonly install: (
    root: string,
    name: string,
    version: string,
    kind: DependencyKind,
  ) => Effect.Effect<void, RecipePackageUnavailable>;
};

export class RecipePackagesClient extends Context.Service<
  RecipePackagesClient,
  RecipePackagesClientService
>()("RecipePackagesClient") {}
