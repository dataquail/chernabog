import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { RecipePackagesClient } from "../../domain/ports/clients/recipe-packages.client.ts";
import { RecipePackageUnavailable } from "../../domain/recipe/recipe.errors.ts";
import {
  newestFirst,
  type RecipeManifest,
  type RecipePackage,
  recipePackageOf,
  supportsSdk,
} from "../../domain/recipe/recipe-package.value-object.ts";
import {
  declaredPackages,
  decodeRepoManifest,
  type DependencyKind,
} from "../../domain/recipe/repo-manifest.value-object.ts";

// One version of a package in the fake registry.
export type FakeRelease = {
  readonly sdkRange?: string;
  readonly recipes: Readonly<Record<string, RecipeManifest>>;
  readonly files: Readonly<Record<string, string>>;
};

// Packages by name, then version.
export type FakeRegistry = Readonly<Record<string, Readonly<Record<string, FakeRelease>>>>;

const PackageText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json), { space: 2 });

// A registry in memory, and a checkout's files in `files` (as
// ChernabogDirClientFake holds them): a package is installed at the version
// its .chernabog/package.json pins, and installing one rewrites that pin, as
// bun add does. `offline` fails every call that would reach the registry.
export const RecipePackagesClientFake = (
  registry: FakeRegistry,
  files: Record<string, string>,
  offline = false,
) => {
  const manifestOf = (root: string) =>
    Option.flatMap(Record.get(files, `${root}/.chernabog/package.json`), (text) =>
      Result.getSuccess(decodeRepoManifest(text)),
    );

  const pinOf = (root: string, name: string) =>
    Option.flatMap(manifestOf(root), (manifest) =>
      Option.orElse(Record.get(manifest.dependencies ?? {}, name), () =>
        Record.get(manifest.devDependencies ?? {}, name),
      ),
    );

  const releaseOf = (name: string, version: string) =>
    Option.flatMap(Record.get(registry, name), (versions) => Record.get(versions, version));

  const describe = (name: string, version: string, release: FakeRelease): RecipePackage =>
    recipePackageOf({
      name,
      version,
      peerDependencies: Option.match(Option.fromUndefinedOr(release.sdkRange), {
        onNone: () => ({}),
        onSome: (range) => ({ "@chernabog/sdk": range }),
      }),
      chernabog: { recipes: release.recipes },
    });

  const unavailable = (name: string) =>
    Effect.fail(new RecipePackageUnavailable({ package: name, message: "offline" }));

  const online = <A>(name: string, effect: Effect.Effect<A, RecipePackageUnavailable>) => {
    if (offline) {
      return unavailable(name);
    }

    return effect;
  };

  return Layer.succeed(
    RecipePackagesClient,
    RecipePackagesClient.of({
      restore: () => Effect.void,
      installed: (root) =>
        Effect.sync(() =>
          Option.match(manifestOf(root), {
            onNone: () => [],
            onSome: (manifest) =>
              declaredPackages(manifest).flatMap((name) =>
                Option.toArray(
                  Option.flatMap(pinOf(root, name), (version) =>
                    Option.map(releaseOf(name, version), (release) =>
                      describe(name, version, release),
                    ),
                  ),
                ),
              ),
          }),
        ),
      file: (root, name, path) =>
        Effect.sync(() =>
          Option.flatMap(
            Option.flatMap(pinOf(root, name), (version) => releaseOf(name, version)),
            (release) => Record.get(release.files, path),
          ),
        ),
      fileAt: (_root, name, version, path) =>
        online(
          name,
          Effect.sync(() =>
            Option.flatMap(releaseOf(name, version), (release) => Record.get(release.files, path)),
          ),
        ),
      newestFor: (_root, name, sdk) =>
        online(
          name,
          Effect.sync(() => {
            const versions: Readonly<Record<string, FakeRelease>> = Option.getOrElse(
              Record.get(registry, name),
              () => ({}),
            );

            return Option.fromUndefinedOr(
              newestFirst(Object.keys(versions)).find((version) =>
                supportsSdk(
                  Option.flatMap(Record.get(versions, version), (release) =>
                    Option.fromUndefinedOr(release.sdkRange),
                  ),
                  sdk,
                ),
              ),
            );
          }),
        ),
      install: (root, name, version, kind: DependencyKind) =>
        online(
          name,
          Effect.gen(function* () {
            const path = `${root}/.chernabog/package.json`;

            const file = yield* Schema.decodeEffect(PackageText)(
              Option.getOrElse(Record.get(files, path), () => "{}"),
            );

            const list = Option.getOrElse(
              Option.flatMap(
                Record.get(file, kind),
                Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String)),
              ),
              () => ({}),
            );

            const written = yield* Schema.encodeEffect(PackageText)({
              ...file,
              [kind]: { ...list, [name]: version },
            });

            files[path] = `${written}\n`;
          }).pipe(Effect.orDie),
        ),
    }),
  );
};
