import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { ScaffoldRefused } from "../../domain/recipe/recipe.errors.ts";
import { type Scaffold } from "../../domain/scaffold/scaffold.value-object.ts";

// A binary bundling this scaffold, and the pin `"pinned"`: a manifest without it gets it, on a line of its
// own; one saying `"too new"` is written for a newer SDK. A module importing
// `gone` imports what its SDK doesn't have.
export const BundleClientFake = (scaffold: Scaffold) =>
  Layer.succeed(
    BundleClient,
    BundleClient.of({
      sdkVersion: "0.6.0",
      scaffold: Effect.succeed(scaffold),
      // The scaffold's schema, naming the repo's flows, if it has any.
      configSchema: (root) =>
        Effect.succeed(
          (scaffold.files["config.schema.json"] ?? "").replace("{flows}", `{flows of ${root}}`),
        ),
      refuseNewer: (manifest) =>
        Effect.fromOption(
          Option.liftPredicate(manifest, (text) => !text.includes('"too new"')),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(() => new ScaffoldRefused({ message: "upgrade chernabog" })),
        ),
      pinned: (manifest) =>
        Effect.succeed(
          Option.liftPredicate(
            `${manifest.trimEnd()}\n"pinned"\n`,
            () => !manifest.includes('"pinned"'),
          ),
        ),
      missingImports: (source) =>
        Option.toArray(Option.liftPredicate("gone", () => source.includes("gone"))),
    }),
  );
