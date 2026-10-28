// What the recipes module reads of a repo's .chernabog/package.json: the
// packages it declares, the SDK its flows are written against, and, under
// `chernabog.copied`, the package and version each copied file came from,
// which `recipes diff` compares with and `recipes update` merges from.

import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { pinnedVersion } from "../../../../kernel/core-support.value-object.ts";
import { RecipeFilesFailed } from "./recipe.errors.ts";
import { SDK_PACKAGE } from "./recipe-package.value-object.ts";

// Where a copied file came from: the recipe, as `<package>/<recipe>`, and
// the package's version.
export const CopiedRecord = Schema.Struct({
  from: Schema.String,
  version: Schema.String,
  // The file's path in the package, where it isn't the same as in the repo:
  // a flow ejected under another name than its recipe's.
  file: Schema.optionalKey(Schema.String),
});

export type CopiedRecord = typeof CopiedRecord.Type;

const Dependencies = Schema.Record(Schema.String, Schema.String);

const RepoManifest = Schema.Struct({
  dependencies: Schema.optionalKey(Dependencies),
  devDependencies: Schema.optionalKey(Dependencies),
  chernabog: Schema.optionalKey(
    Schema.Struct({ copied: Schema.optionalKey(Schema.Record(Schema.String, CopiedRecord)) }),
  ),
});

export type RepoManifest = typeof RepoManifest.Type;

const ManifestText = Schema.fromJsonString(RepoManifest);

// The whole file, for writing records without losing the keys RepoManifest doesn't name.
const PackageText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json), { space: 2 });

// The `chernabog` key as JSON, keeping keys this binary doesn't name.
const PackageSection = Schema.Record(Schema.String, Schema.Json);

const invalid = (error: { readonly message: string }) =>
  new RecipeFilesFailed({ message: `.chernabog/package.json: ${error.message}` });

export const decodeRepoManifest = (text: string) =>
  Result.mapError(Schema.decodeResult(ManifestText)(text), invalid);

export type DependencyKind = "dependencies" | "devDependencies";

// Which list declares a package: `dependencies` first, since a snapshot installs those.
export const dependencyKind = (
  manifest: RepoManifest,
  name: string,
): Option.Option<DependencyKind> =>
  Option.orElse(
    Option.as(Record.get(manifest.dependencies ?? {}, name), "dependencies" as const),
    () => Option.as(Record.get(manifest.devDependencies ?? {}, name), "devDependencies" as const),
  );

// Every package the manifest declares, in either list.
export const declaredPackages = (manifest: RepoManifest) => [
  ...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]),
];

// The SDK version the repo's flows are written against; none without an exact pin.
export const sdkVersionOf = (manifest: RepoManifest) =>
  Option.flatMap(
    Option.orElse(Record.get(manifest.dependencies ?? {}, SDK_PACKAGE), () =>
      Record.get(manifest.devDependencies ?? {}, SDK_PACKAGE),
    ),
    pinnedVersion,
  );

export const copiedOf = (manifest: RepoManifest): Readonly<Record<string, CopiedRecord>> =>
  manifest.chernabog?.copied ?? {};

// The manifest with these records set (a none removes one), by path under
// .chernabog/, kept in path order.
export const withCopied = (
  text: string,
  changes: Readonly<Record<string, Option.Option<CopiedRecord>>>,
) =>
  Result.gen(function* () {
    const file = yield* Result.mapError(Schema.decodeResult(PackageText)(text), invalid);
    const manifest = yield* decodeRepoManifest(text);

    const chernabog = Option.getOrElse(
      Option.flatMap(Record.get(file, "chernabog"), Schema.decodeUnknownOption(PackageSection)),
      () => ({}),
    );

    const copied: Record<string, CopiedRecord> = { ...copiedOf(manifest) };

    for (const [path, change] of Object.entries(changes)) {
      Option.match(change, {
        onNone: () => {
          delete copied[path];
        },
        onSome: (record) => {
          copied[path] = record;
        },
      });
    }

    const sorted = Object.fromEntries(
      Object.keys(copied)
        .toSorted()
        .map((path) => [path, copied[path]]),
    );

    const section = Option.match(
      Option.liftPredicate(sorted, (left) => !Record.isEmptyRecord(left)),
      {
        onNone: () => Record.remove(chernabog, "copied"),
        onSome: (kept) => ({ ...chernabog, copied: kept }),
      },
    );

    const written = Option.match(
      Option.liftPredicate(section, (left) => !Record.isEmptyRecord(left)),
      {
        onNone: () => Record.remove(file, "chernabog"),
        onSome: (kept) => ({ ...file, chernabog: kept }),
      },
    );

    return `${yield* Result.mapError(Schema.encodeResult(PackageText)(written), invalid)}\n`;
  });

// The manifest without a package in one of its lists, so installing it into
// the other moves it there.
export const withoutDependency = (text: string, name: string, kind: DependencyKind) =>
  Result.gen(function* () {
    const file = yield* Result.mapError(Schema.decodeResult(PackageText)(text), invalid);

    const list = Option.getOrElse(
      Option.flatMap(Record.get(file, kind), Schema.decodeUnknownOption(Dependencies)),
      () => ({}),
    );

    return `${yield* Result.mapError(
      Schema.encodeResult(PackageText)({ ...file, [kind]: Record.remove(list, name) }),
      invalid,
    )}\n`;
  });
