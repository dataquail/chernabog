import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type ScaffoldRefused } from "../../recipe/recipe.errors.ts";
import { type Scaffold } from "../../scaffold/scaffold.value-object.ts";

// What this chernabog binary bundles for a repo's .chernabog/: the scaffold,
// and the versions of the packages flows are written against. It bundles no
// recipes: those are packages a repo installs (RecipePackagesClient).
export type BundleClientService = {
  // The @chernabog/sdk version released with this binary, which a new or
  // upgraded .chernabog/ is pinned to.
  readonly sdkVersion: string;
  readonly scaffold: Effect.Effect<Scaffold>;
  // Fails when a .chernabog/package.json's flows are typed against a newer
  // core than this binary provides, so it must not rewrite them.
  readonly refuseNewer: (manifest: string) => Effect.Effect<void, ScaffoldRefused>;
  // A .chernabog/package.json with this binary's pins; none when it has them already.
  readonly pinned: (manifest: string) => Effect.Effect<Option.Option<string>, ScaffoldRefused>;
  // What a flow or step module imports straight from @chernabog/core that this
  // binary's core doesn't export, such as Claims.releaseAll.
  readonly missingImports: (source: string) => ReadonlyArray<string>;
};

export class BundleClient extends Context.Service<BundleClient, BundleClientService>()(
  "BundleClient",
) {}
