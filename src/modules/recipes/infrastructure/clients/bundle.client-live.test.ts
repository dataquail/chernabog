import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { BundleClientLive } from "./bundle.client-live.ts";

describe("BundleClientLive", () => {
  effect("bundles each recipe file, the scaffold with its generated schemas, and the pins", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;
      const scaffold = yield* bundle.scaffold;

      expect(yield* bundle.recipeFile("flows/review.ts")).toContain("defineFlow");
      expect(Object.keys(scaffold.files)).toContain("config.yaml");
      expect(scaffold.generated).toEqual(["config.schema.json", "rehearsal.schema.json"]);
      expect(scaffold.files["rehearsal.schema.json"]).toContain('"localGate"');
      expect(yield* bundle.pinned(scaffold.manifest)).toEqual(Option.none());
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("refuses a manifest written against a newer SDK, and not an older one", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;

      const refused = yield* Effect.flip(
        bundle.refuseNewer('{ "devDependencies": { "@chernabog/sdk": "99.0.0" } }'),
      );

      expect(refused.message).toContain("upgrade chernabog");
      yield* bundle.refuseNewer('{ "devDependencies": { "@chernabog/sdk": "0.0.1" } }');
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("moves the pins and drops engines.chernabog", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;

      const pinned = Option.getOrThrow(
        yield* bundle.pinned(
          '{ "engines": { "chernabog": ">=0.3.0", "node": ">=20" }, "devDependencies": { "@chernabog/sdk": "0.5.0" } }',
        ),
      );

      expect(pinned).toContain(`"@chernabog/sdk": "${bundle.sdkVersion}"`);
      expect(pinned).toContain('"engines": {\n    "node": ">=20"\n  }');
      expect(pinned).not.toContain('"chernabog"');
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("names what a module imports that this SDK doesn't export", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;

      expect(
        bundle.missingImports(
          'import { Review, defineFlow, fixTrigger, type Gone } from "@chernabog/sdk";\nReview.fixTrigger; Review.recheck;\n',
        ),
      ).toEqual(["Review.fixTrigger", "fixTrigger"]);
    }).pipe(Effect.provide(BundleClientLive)),
  );
});
