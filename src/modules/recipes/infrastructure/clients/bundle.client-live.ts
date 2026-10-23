// What this binary bundles for a repo's .chernabog/: the recipes and the
// scaffold generated from templates/ (src/templates.ts), the config schema
// generated from this binary's RepoConfigFile, and the pins of its packages.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  checkVersion,
  decodeManifest,
  flowPackageText,
  withBundledPins,
} from "../../../../flow-deps.ts";
import { RepoConfigFile } from "../../../../repo-config.ts";
import { RECIPE_FILES, TEMPLATES } from "../../../../templates.ts";
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
    // The catalog names only files templates/recipes/ has, so one missing is a bug.
    recipeFile: (file) =>
      Effect.fromOption(
        Option.map(
          Arr.findFirst(Object.entries(RECIPE_FILES), ([name]) => name === file),
          ([, text]) => text,
        ),
      ).pipe(Effect.orDie),
    scaffold: Effect.sync(() => {
      const { "package.json": manifest, ...files } = scaffoldFiles();

      return { files, generated: Object.keys(schemaFiles()), manifest };
    }),
    checkFloor: (manifest) =>
      decodeManifest(manifest).pipe(
        Effect.flatMap(checkVersion),
        Effect.asVoid,
        Effect.mapError(refused),
      ),
    pinned: (manifest, raise) => withBundledPins(manifest, raise).pipe(Effect.mapError(refused)),
  }),
);
