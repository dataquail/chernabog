// What this binary bundles for a repo's .chernabog/: the scaffold generated
// from templates/ (src/platform/templates.ts), the config schema generated
// from this binary's RepoConfigFile, and the pins of its packages: core and
// effect as it bundles them, and the SDK released with it.

import { type Flow } from "@chernabog/core";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
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
import { loadFlows } from "../../../../platform/flow-loader.ts";
import { TEMPLATES } from "../../../../platform/templates.ts";
import { RepoConfigFile } from "../../../../repo-config.ts";
import { BundleClient } from "../../domain/ports/clients/bundle.client.ts";
import { ScaffoldRefused } from "../../domain/recipe/recipe.errors.ts";

const JsonText = Schema.fromJsonString(Schema.Json, { space: 2 });

type JsonObject = { readonly [key: string]: Schema.Json };

const isJsonObject = (json: Schema.Json): json is JsonObject =>
  Predicate.isObject(json) && !Array.isArray(json);

const objectOf = (json: Option.Option<Schema.Json>): JsonObject =>
  Option.getOrElse(Option.filter(json, isJsonObject), () => ({}));

// The object under `key`; an empty one when there is none.
const field = (json: Schema.Json, key: string) =>
  objectOf(
    Option.flatMap(Option.liftPredicate(json, isJsonObject), (found) => Record.get(found, key)),
  );

const documentOf = (schema: Schema.Constraint) => {
  const document = Schema.toJsonSchemaDocument(schema);

  return {
    schema: Schema.decodeUnknownSync(Schema.Json)(document.schema),
    definitions: objectOf(Option.some(Schema.decodeUnknownSync(Schema.Json)(document.definitions))),
  };
};

const textOf = (schema: Schema.Json, definitions: JsonObject) =>
  `${Schema.encodeSync(JsonText)({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...objectOf(Option.some(schema)),
    $defs: definitions,
  })}\n`;

// A config file's JSON Schema, for editor autocomplete.
const jsonSchemaOf = (schema: Schema.Constraint) => {
  const document = documentOf(schema);

  return textOf(document.schema, document.definitions);
};

// config.yaml's JSON Schema, with each flow's settings as its schema declares
// them, under flows.<name>.settings, and every flow's together under settings:.
export const configSchemaWith = (flows: ReadonlyMap<string, Flow>) => {
  const base = documentOf(RepoConfigFile);

  const declared = [...flows].flatMap(([name, flow]) =>
    Option.toArray(
      Option.map(Option.fromUndefinedOr(flow.settings), (settings) => ({
        name,
        document: documentOf(settings),
      })),
    ),
  );

  if (declared.length === 0) {
    return textOf(base.schema, base.definitions);
  }

  const properties = field(base.schema, "properties");
  const flowsKey = field(properties, "flows");
  const anyFlow = field(flowsKey, "additionalProperties");

  const named = Object.fromEntries(
    declared.map(({ document, name }) => [
      name,
      { ...anyFlow, properties: { ...field(anyFlow, "properties"), settings: document.schema } },
    ]),
  );

  // A key two flows declare is described as the first one declares it.
  const shared = Object.fromEntries(
    declared
      .toReversed()
      .flatMap(({ document }) => Object.entries(field(document.schema, "properties"))),
  );

  const definitions = Object.fromEntries([
    ...Object.entries(base.definitions),
    ...declared.flatMap(({ document }) => Object.entries(document.definitions)),
  ]);

  return textOf(
    {
      ...objectOf(Option.some(base.schema)),
      properties: {
        ...properties,
        settings: { ...field(properties, "settings"), type: "object", properties: shared },
        flows: { ...flowsKey, properties: { ...field(flowsKey, "properties"), ...named } },
      },
    },
    definitions,
  );
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

export const BundleClientLive = Layer.effect(
  BundleClient,
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem>();

    // The flows of the repo at `root`, as this binary loads them; none when they don't load.
    const flowsOf = (root: string) =>
      loadFlows(`${root}/.chernabog`).pipe(
        Effect.orElseSucceed((): ReadonlyMap<string, Flow> => new Map()),
        Effect.provideContext(context),
      );

    return BundleClient.of({
      sdkVersion: RELEASED_SDK,
      configSchema: (root) => Effect.map(flowsOf(root), configSchemaWith),
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
    });
  }),
);
