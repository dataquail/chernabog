// A checkout's recipe packages, which bun installs into its .chernabog/ from
// .chernabog/package.json and its lockfile, with this binary acting as bun.
// bun reads .chernabog/.npmrc, so a company's private registry and its auth
// need nothing of chernabog's.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HostEnvironment } from "../../../../platform/environment.ts";
import { Exec } from "../../../../platform/exec.ts";
import { bunExecutable } from "../../../../platform/self.ts";
import { RecipePackagesClient } from "../../domain/ports/clients/recipe-packages.client.ts";
import { RecipeFilesFailed, RecipePackageUnavailable } from "../../domain/recipe/recipe.errors.ts";
import {
  newestFirst,
  type RecipePackage,
  RecipePackageManifest,
  recipePackageOf,
  supportsSdk,
} from "../../domain/recipe/recipe-package.value-object.ts";
import {
  declaredPackages,
  decodeRepoManifest,
} from "../../domain/recipe/repo-manifest.value-object.ts";

// What marks a package as a recipe package, before its manifest is checked.
const HasRecipes = Schema.Struct({ chernabog: Schema.Struct({ recipes: Schema.Unknown }) });

const Versions = Schema.fromJsonString(Schema.Array(Schema.String));

const Peers = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const Json = Schema.fromJsonString(Schema.Unknown);

const PackageText = Schema.fromJsonString(Schema.Json);

// bun add's flag for the list a package goes in.
const LIST_FLAGS = { dependencies: [], devDependencies: ["--dev"] } as const;

// The files a registry or install shouldn't see but bun needs to reach it.
const REGISTRY_FILES = [".npmrc", "bunfig.toml"];

const lastLines = (text: string) => Arr.takeRight(text.trim().split("\n"), 5).join("\n");

export const RecipePackagesClientLive = Layer.effect(
  RecipePackagesClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exec = yield* Exec;
    const host = yield* HostEnvironment;
    // Files of package versions fetched for a merge base, by name@version.
    const fetched = new Map<string, ReadonlyMap<string, string>>();

    const bun = (cwd: string, name: string, args: ReadonlyArray<string>) =>
      exec
        .run(bunExecutable(), args, {
          cwd,
          env: { ...host.variables, BUN_BE_BUN: "1" },
          timeout: "5 minutes",
        })
        .pipe(
          Effect.mapError(
            (error) => new RecipePackageUnavailable({ package: name, message: error.message }),
          ),
          Effect.flatMap((result) => {
            if (result.exitCode === 0) {
              return Effect.succeed(result.stdout);
            }

            return Effect.fail(
              new RecipePackageUnavailable({
                package: name,
                message: `bun ${args.join(" ")} failed in ${cwd}:\n${lastLines(`${result.stdout}\n${result.stderr}`)}`,
              }),
            );
          }),
        );

    const readText = (path: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path))) {
          return Option.none<string>();
        }

        return Option.some(yield* fs.readFileString(path));
      }).pipe(Effect.mapError((error) => new RecipeFilesFailed({ message: error.message })));

    const declared = (root: string) =>
      Effect.gen(function* () {
        const text = yield* readText(`${root}/.chernabog/package.json`);

        return yield* Option.match(text, {
          onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
          onSome: (found) =>
            Effect.map(Effect.fromResult(decodeRepoManifest(found)), declaredPackages),
        });
      });

    const packageDir = (root: string, name: string) => `${root}/.chernabog/node_modules/${name}`;

    const restore = (root: string) =>
      Effect.gen(function* () {
        const names = yield* declared(root).pipe(
          Effect.mapError(
            (error) => new RecipePackageUnavailable({ package: "", message: error.message }),
          ),
        );

        const missing: Array<string> = [];

        for (const name of names) {
          if (
            !(yield* fs
              .exists(`${packageDir(root, name)}/package.json`)
              .pipe(Effect.orElseSucceed(() => false)))
          ) {
            missing.push(name);
          }
        }

        if (missing.length > 0) {
          yield* bun(`${root}/.chernabog`, missing.join(", "), ["install", "--ignore-scripts"]);
        }
      });

    const sync = (root: string) =>
      bun(`${root}/.chernabog`, "package.json", ["install", "--ignore-scripts"]).pipe(
        Effect.asVoid,
      );

    const describe = (root: string, name: string) =>
      Effect.gen(function* () {
        const text = yield* readText(`${packageDir(root, name)}/package.json`);

        if (Option.isNone(text)) {
          return Option.none<RecipePackage>();
        }

        const json = yield* Schema.decodeEffect(Json)(text.value).pipe(
          Effect.mapError(
            (error) => new RecipeFilesFailed({ message: `${name}/package.json: ${error.message}` }),
          ),
        );

        if (Option.isNone(Schema.decodeUnknownOption(HasRecipes)(json))) {
          return Option.none<RecipePackage>();
        }

        const manifest = yield* Schema.decodeUnknownEffect(RecipePackageManifest)(json).pipe(
          Effect.mapError(
            (error) =>
              new RecipeFilesFailed({
                message: `${name} isn't a valid recipe package: ${error.message}`,
              }),
          ),
        );

        return Option.some(recipePackageOf(manifest));
      });

    const installed = (root: string) =>
      Effect.gen(function* () {
        const found: Array<RecipePackage> = [];

        for (const name of yield* declared(root)) {
          for (const described of Option.toArray(yield* describe(root, name))) {
            found.push(described);
          }
        }

        return found;
      });

    const file = (root: string, name: string, path: string) =>
      readText(`${packageDir(root, name)}/${path}`);

    // Installs name@version on its own in a scratch directory, with the
    // repo's registry settings, and keeps its recipes' files.
    const fetch = (root: string, name: string, version: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-recipes-" });

          const manifest = yield* Schema.encodeEffect(PackageText)({
            private: true,
            dependencies: { [name]: version },
          }).pipe(Effect.orDie);

          yield* fs.writeFileString(`${scratch}/package.json`, `${manifest}\n`);

          for (const registryFile of REGISTRY_FILES) {
            const path = `${root}/.chernabog/${registryFile}`;

            if (yield* fs.exists(path)) {
              yield* fs.copyFile(path, `${scratch}/${registryFile}`);
            }
          }

          yield* bun(scratch, name, ["install", "--ignore-scripts", "--omit", "peer", "--no-save"]);

          const files = new Map<string, string>();
          const directory = `${scratch}/node_modules/${name}`;

          for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
            if ((yield* fs.stat(`${directory}/${entry}`)).type === "File") {
              files.set(entry, yield* fs.readFileString(`${directory}/${entry}`));
            }
          }

          return files;
        }),
      ).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(new RecipePackageUnavailable({ package: name, message: error.message })),
        ),
      );

    const fileAt = (root: string, name: string, version: string, path: string) =>
      Effect.gen(function* () {
        const here = yield* describe(root, name).pipe(
          Effect.orElseSucceed(() => Option.none<RecipePackage>()),
        );

        if (Option.exists(here, (found) => found.version === version)) {
          return yield* file(root, name, path).pipe(
            Effect.mapError(
              (error) => new RecipePackageUnavailable({ package: name, message: error.message }),
            ),
          );
        }

        const key = `${name}@${version}`;

        const files = yield* Option.match(Option.fromUndefinedOr(fetched.get(key)), {
          onSome: (found) => Effect.succeed(found),
          onNone: () =>
            Effect.tap(fetch(root, name, version), (found) =>
              Effect.sync(() => {
                fetched.set(key, found);
              }),
            ),
        });

        return Option.fromUndefinedOr(files.get(path));
      });

    const newestFor = (root: string, name: string, sdk: string) =>
      Effect.gen(function* () {
        const cwd = `${root}/.chernabog`;
        const listed = yield* bun(cwd, name, ["info", name, "versions", "--json"]);

        const versions = yield* Schema.decodeEffect(Versions)(listed).pipe(
          Effect.mapError(
            (error) =>
              new RecipePackageUnavailable({
                package: name,
                message: `bun info ${name} versions: ${error.message}`,
              }),
          ),
        );

        for (const version of newestFirst(versions)) {
          const peers = yield* bun(cwd, name, [
            "info",
            `${name}@${version}`,
            "peerDependencies",
            "--json",
          ]);

          const range = Option.flatMap(Schema.decodeOption(Peers)(peers.trim()), (found) =>
            Option.fromUndefinedOr(found["@chernabog/sdk"]),
          );

          if (supportsSdk(range, sdk)) {
            return Option.some(version);
          }
        }

        return Option.none<string>();
      });

    const install = (
      root: string,
      name: string,
      version: string,
      kind: "dependencies" | "devDependencies",
    ) =>
      bun(`${root}/.chernabog`, name, [
        "add",
        "--exact",
        "--ignore-scripts",
        ...LIST_FLAGS[kind],
        `${name}@${version}`,
      ]).pipe(Effect.asVoid);

    return RecipePackagesClient.of({
      restore,
      sync,
      installed,
      file,
      fileAt,
      newestFor,
      install,
    });
  }),
);
