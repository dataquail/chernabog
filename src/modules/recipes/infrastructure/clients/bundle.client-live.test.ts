import { defineFlow } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { BUNDLED_CORE_VERSION } from "../../../../kernel/core-support.value-object.ts";
import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { BundleClientLive, configSchemaWith, scaffoldFiles } from "./bundle.client-live.ts";

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

  const promote = defineFlow({
    trigger: Effect.succeed([]),
    settings: Schema.Struct({
      promoteFrom: Schema.String.annotate({ description: "The branch a release promotes from" }),
    }),
    workflow: () => Effect.void,
  });

  const Described = Schema.fromJsonString(
    Schema.Struct({
      properties: Schema.Struct({
        settings: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) }),
        flows: Schema.Struct({
          properties: Schema.Record(
            Schema.String,
            Schema.Struct({
              properties: Schema.Struct({
                schedule: Schema.Json,
                settings: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) }),
              }),
            }),
          ),
        }),
      }),
    }),
  );

  effect("describes each flow's settings from its schema, and all of them under settings:", () =>
    Effect.gen(function* () {
      const described = yield* Schema.decodeEffect(Described)(
        configSchemaWith(new Map([["promote", promote]])),
      );

      const promoteFrom = { type: "string", description: "The branch a release promotes from" };
      expect(described.properties.flows.properties.promote.properties.settings.properties).toEqual({
        promoteFrom,
      });
      expect(described.properties.flows.properties.promote.properties.schedule).toEqual({
        type: "string",
      });
      expect(described.properties.settings.properties).toEqual({ promoteFrom });
    }),
  );

  effect("writes the config alone for a repo whose flows don't load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-bundle-" });

      expect(yield* (yield* BundleClient).configSchema(root)).toBe(
        scaffoldFiles()["config.schema.json"],
      );
    }).pipe(Effect.provide(BundleClientLive)),
  );
});
