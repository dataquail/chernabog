// What this binary bundles for a repo's .chernabog/: the scaffold generated
// from templates/ (src/platform/templates.ts), the config schema generated
// from this binary's RepoConfigFile, and the pins of its packages: core and
// effect as it bundles them, and the SDK released with it.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ScenarioFile } from "../../../../kernel/scenario.value-object.ts";
import {
  decodeManifest,
  flowPackageText,
  incompatibility,
  missingCoreImports,
  RELEASED_SDK,
  withBundledPins,
  writtenForNewer,
} from "../../../../platform/flow-deps.ts";
import { TEMPLATES } from "../../../../platform/templates.ts";
import { RepoConfigFile } from "../../../../repo-config.ts";
import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { ScaffoldRefused } from "../../domain/recipe/recipe.errors.ts";

const JsonText = Schema.fromJsonString(Schema.Json, { space: 2 });

// A config file's JSON Schema, for editor autocomplete.
const jsonSchemaOf = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);

  const json = Schema.decodeUnknownSync(Schema.Json)({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  });

  return `${Schema.encodeSync(JsonText)(json)}\n`;
};

// Generated from the config schemas, so init rewrites them to pick up new keys.
const schemaFiles = () => ({
  "config.schema.json": jsonSchemaOf(RepoConfigFile),
  // For .chernabog/rehearsals/<name>.yaml (chernabog rehearse).
  "rehearsal.schema.json": jsonSchemaOf(ScenarioFile),
});

// Every file init writes, by path under .chernabog/, before any recipe.
export const scaffoldFiles = () => ({
  ...TEMPLATES,
  ...schemaFiles(),
  "package.json": flowPackageText(),
});

const refused = (error: { readonly message: string }) =>
  new ScaffoldRefused({ message: error.message });

export const BundleClientLive = Layer.succeed(
  BundleClient,
  BundleClient.of({
    sdkVersion: RELEASED_SDK,
    scaffold: Effect.sync(() => {
      const { "package.json": manifest, ...files } = scaffoldFiles();

      return { files, generated: Object.keys(schemaFiles()), manifest };
    }),
    refuseNewer: (manifest) =>
      decodeManifest(manifest).pipe(
        Effect.mapError(refused),
        Effect.flatMap((decoded) =>
          Effect.fromOption(
            Option.filter(incompatibility(decoded), () => writtenForNewer(decoded)),
          ).pipe(
            Effect.flip,
            Effect.mapError((message) => refused({ message })),
          ),
        ),
      ),
    pinned: (manifest) => withBundledPins(manifest).pipe(Effect.mapError(refused)),
    missingImports: missingCoreImports,
  }),
);
