import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { BundleClientLive } from "./bundle.client-live.ts";

describe("BundleClientLive", () => {
  effect("bundles each recipe file, the scaffold with its generated schema, and the pins", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;
      const scaffold = yield* bundle.scaffold;

      expect(yield* bundle.recipeFile("flows/review.ts")).toContain("defineFlow");
      expect(Object.keys(scaffold.files)).toContain("config.yaml");
      expect(scaffold.generated).toEqual(["config.schema.json"]);
      expect(yield* bundle.pinned(scaffold.manifest, false)).toEqual(Option.none());
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("refuses a manifest whose floor is a newer chernabog", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        (yield* BundleClient).checkFloor('{ "engines": { "chernabog": ">=999.0.0" } }'),
      );

      expect(refused.message).toContain("999.0.0");
    }).pipe(Effect.provide(BundleClientLive)),
  );
});
