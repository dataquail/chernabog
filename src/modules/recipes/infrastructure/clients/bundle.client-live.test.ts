import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { BUNDLED_CORE_VERSION } from "../../../../kernel/core-support.value-object.ts";
import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { BundleClientLive } from "./bundle.client-live.ts";

describe("BundleClientLive", () => {
  effect("bundles the scaffold with its generated schemas, and the pins", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;
      const scaffold = yield* bundle.scaffold;

      expect(Object.keys(scaffold.files)).toContain("config.yaml");
      expect(scaffold.generated).toEqual(["config.schema.json", "rehearsal.schema.json"]);
      expect(scaffold.files["rehearsal.schema.json"]).toContain('"localGate"');
      expect(yield* bundle.pinned(scaffold.manifest)).toEqual(Option.none());
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("refuses a manifest typed against a newer core, and not an older one", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;

      const refused = yield* Effect.flip(
        bundle.refuseNewer(
          '{ "dependencies": { "@chernabog/sdk": "0.8.0" }, "devDependencies": { "@chernabog/core": "99.0.0" } }',
        ),
      );

      expect(refused.message).toContain("upgrade chernabog");
      yield* bundle.refuseNewer('{ "devDependencies": { "@chernabog/core": "0.0.1" } }');
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("moves the pins, lists the SDK in dependencies, and drops engines.chernabog", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;

      const pinned = Option.getOrThrow(
        yield* bundle.pinned(
          '{ "engines": { "chernabog": ">=0.3.0", "node": ">=20" }, "devDependencies": { "@chernabog/sdk": "0.5.0" } }',
        ),
      );

      expect(pinned).toContain(
        `"dependencies": {\n    "@chernabog/sdk": "${bundle.sdkVersion}"\n  }`,
      );
      expect(pinned).toContain(`"@chernabog/core": "${BUNDLED_CORE_VERSION}"`);
      expect(pinned).toContain('"engines": {\n    "node": ">=20"\n  }');
      expect(pinned).not.toContain('"chernabog"');
    }).pipe(Effect.provide(BundleClientLive)),
  );

  effect("names what a module imports straight from core that this core doesn't export", () =>
    Effect.gen(function* () {
      const bundle = yield* BundleClient;

      expect(
        bundle.missingImports(
          'import { Claims, defineFlow, fixTrigger, type Gone } from "@chernabog/core";\nClaims.vanished; Claims.releasing;\n',
        ),
      ).toEqual(["Claims.vanished", "fixTrigger"]);
    }).pipe(Effect.provide(BundleClientLive)),
  );
});
