import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type ScaffoldRefused } from "../../recipe/recipe.errors.ts";
import { type Scaffold } from "../../scaffold/scaffold.value-object.ts";

// What this chernabog binary bundles for a repo's .chernabog/: the scaffold,
// and the versions of the packages flows are written against. It bundles no
// recipes: those are packages a repo installs (RecipePackagesClient).
export type BundleClientService = {
  // The @chernabog/sdk version this binary bundles, which flows are written against.
  readonly sdkVersion: string;
  readonly scaffold: Effect.Effect<Scaffold>;
  // Fails when a .chernabog/package.json's flows are written against a newer
  // SDK than this binary runs, so it must not rewrite them.
  readonly refuseNewer: (manifest: string) => Effect.Effect<void, ScaffoldRefused>;
  // A .chernabog/package.json with this binary's pins; none when it has them already.
  readonly pinned: (manifest: string) => Effect.Effect<Option.Option<string>, ScaffoldRefused>;
  // What a flow or step module imports from the SDK that this binary's SDK
  // doesn't export, such as Review.fixTrigger.
  readonly missingImports: (source: string) => ReadonlyArray<string>;
};

export class BundleClient extends Context.Service<BundleClient, BundleClientService>()(
  "BundleClient",
) {}
