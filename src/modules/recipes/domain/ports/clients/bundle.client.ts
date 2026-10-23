import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type ScaffoldRefused } from "../../recipe/recipe.errors.ts";
import { type Scaffold } from "../../scaffold/scaffold.value-object.ts";

// What this chernabog binary bundles for a repo's .chernabog/: each recipe's
// files, the scaffold, and the versions of the packages flows are written
// against.
export type BundleClientService = {
  // A recipe's file, by path under .chernabog/, as this binary has it.
  readonly recipeFile: (file: string) => Effect.Effect<string>;
  readonly scaffold: Effect.Effect<Scaffold>;
  // Fails when a .chernabog/package.json needs a newer chernabog than this.
  readonly checkFloor: (manifest: string) => Effect.Effect<void, ScaffoldRefused>;
  // A .chernabog/package.json with this binary's pins, and its chernabog floor
  // raised to this binary when it picks something of it up (or `raise`); none
  // when it has them already.
  readonly pinned: (
    manifest: string,
    raise: boolean,
  ) => Effect.Effect<Option.Option<string>, ScaffoldRefused>;
};

export class BundleClient extends Context.Service<BundleClient, BundleClientService>()(
  "BundleClient",
) {}
