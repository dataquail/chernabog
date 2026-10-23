import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { ScaffoldRefused } from "../../domain/recipe/recipe.errors.ts";
import { type Scaffold } from "../../domain/scaffold/scaffold.value-object.ts";

// A binary bundling each recipe file as `recipe of <file>`, this scaffold,
// and the pin `"pinned"`: a manifest without it gets it, on a line of its
// own; one saying `"too new"` needs a newer chernabog.
export const BundleClientFake = (scaffold: Scaffold) =>
  Layer.succeed(
    BundleClient,
    BundleClient.of({
      recipeFile: (file) => Effect.succeed(`recipe of ${file}\n`),
      scaffold: Effect.succeed(scaffold),
      checkFloor: (manifest) =>
        Effect.fromOption(
          Option.liftPredicate(manifest, (text) => !text.includes('"too new"')),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(() => new ScaffoldRefused({ message: "needs a newer chernabog" })),
        ),
      pinned: (manifest, raise) =>
        Effect.succeed(
          Option.liftPredicate(
            `${manifest.trimEnd()}\n"pinned"\n`,
            () => raise || !manifest.includes('"pinned"'),
          ),
        ),
    }),
  );
