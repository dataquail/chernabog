// A repo's .chernabog/ is a package of its own. Its package.json pins
// @chernabog/sdk and effect, as dev dependencies, at the versions this binary
// bundles, so an editor types flows against what actually runs them; the loader
// substitutes the binary's copies at runtime whatever is installed. Anything
// else a flow or step imports goes in `dependencies` and is installed into each
// snapshot, so every repo, JS or not, declares its flows' packages the same way.
// `engines.chernabog` is the oldest binary that runs it, a floor such as
// ">=0.3.0": an older one refuses the repo rather than misread it.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import SdkPackage from "../../packages/sdk/package.json" with { type: "json" };
import { ConfigError } from "./config-error.ts";
import { EFFECT_VERSION } from "./effect-modules.ts";
import { HostEnvironment } from "./environment.ts";
import { Exec } from "./exec.ts";
import { bunExecutable } from "./self.ts";
import { VERSION } from "./version.ts";

// The packages the loader substitutes, at the versions it substitutes.
export const BUNDLED_PACKAGES: Readonly<Record<string, string>> = {
  "@chernabog/sdk": SdkPackage.version,
  effect: EFFECT_VERSION,
};

const Dependencies = Schema.Record(Schema.String, Schema.String);

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Dependencies),
  devDependencies: Schema.optionalKey(Dependencies),
  engines: Schema.optionalKey(Dependencies),
});

export type Manifest = typeof Manifest.Type;

const ManifestText = Schema.fromJsonString(Manifest);

// The whole file, for rewriting the pins without losing the keys Manifest doesn't name.
const PackageText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json), { space: 2 });

const LOCKFILES = ["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

const invalid = (error: { readonly message: string }) =>
  new ConfigError({ message: `.chernabog/package.json: ${error.message}` });

export const decodeManifest = (text: string) =>
  Schema.decodeEffect(ManifestText)(text).pipe(Effect.mapError(invalid));

const THIS_FLOOR = `>=${VERSION}`;

// package.json for a new .chernabog/.
export const flowPackageText = () =>
  `${Schema.encodeSync(PackageText)({ private: true, engines: { chernabog: THIS_FLOOR }, devDependencies: { ...BUNDLED_PACKAGES } })}\n`;

const FLOOR = /^>=\s*(\d+\.\d+\.\d+)$/;

// The oldest chernabog the manifest runs on; none when it doesn't say.
export const requiredVersion = (manifest: Manifest) =>
  Effect.gen(function* () {
    const declared = Record.get(manifest.engines ?? {}, "chernabog");

    if (Option.isNone(declared)) {
      return Option.none<string>();
    }

    const floor = Option.flatMap(Option.fromNullishOr(FLOOR.exec(declared.value.trim())), (match) =>
      Option.fromUndefinedOr(match[1]),
    );

    if (Option.isNone(floor)) {
      return yield* new ConfigError({
        message: `.chernabog/package.json: engines.chernabog is "${declared.value}"; it must be a floor such as "${THIS_FLOOR}"`,
      });
    }

    return floor;
  });

export const isTooOld = (required: string) => Bun.semver.order(VERSION, required) < 0;

export const describeTooOld = (required: string) =>
  `.chernabog/ needs chernabog ${required} or newer, and this is ${VERSION}; upgrade chernabog`;

// Fails when this binary is older than the one the manifest needs.
export const checkVersion = (manifest: Manifest) =>
  Effect.gen(function* () {
    for (const required of Option.toArray(yield* requiredVersion(manifest))) {
      if (isTooOld(required)) {
        return yield* new ConfigError({ message: describeTooOld(required) });
      }
    }
  });

// Checks the .chernabog/ in `configDir` runs on this binary, before anything
// else in it is read; one without package.json runs on any.
export const checkConfigVersion = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/package.json`;

    if (!(yield* fs.exists(path))) {
      return;
    }

    yield* checkVersion(yield* decodeManifest(yield* fs.readFileString(path)));
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: `.chernabog/package.json: ${error.message}` })),
    ),
  );

export type Drift = {
  readonly name: string;
  readonly wanted: string;
  readonly declared: Option.Option<string>;
};

// Each bundled package the manifest leaves out or pins to another version than this binary's.
export const pinDrift = (manifest: Manifest): ReadonlyArray<Drift> =>
  Record.toEntries(BUNDLED_PACKAGES).flatMap(([name, wanted]) => {
    const declared = Option.orElse(Record.get(manifest.dependencies ?? {}, name), () =>
      Record.get(manifest.devDependencies ?? {}, name),
    );

    if (Option.contains(declared, wanted)) {
      return [];
    }

    return [{ name, wanted, declared }];
  });

export const describeDrift = (drift: Drift) =>
  Option.match(drift.declared, {
    onNone: () => `${drift.name} missing`,
    onSome: (declared) => `${drift.name} ${declared}, not ${drift.wanted}`,
  });

// The same package.json with the bundled packages pinned to this binary's
// versions, as dev dependencies, and engines.chernabog raised to it when that
// is missing, or when the pins move or `raise` asks; none when nothing changes.
// The floor only rises: a binary older than it is refused before this.
export const withBundledPins = (text: string, raise: boolean) =>
  Effect.gen(function* () {
    const manifest = yield* decodeManifest(text);
    const drift = pinDrift(manifest);
    const required = yield* requiredVersion(manifest);

    const raiseFloor = Option.match(required, {
      onNone: () => true,
      onSome: (floor) => (raise || drift.length > 0) && Bun.semver.order(floor, VERSION) < 0,
    });

    if (drift.length === 0 && !raiseFloor) {
      return Option.none<string>();
    }

    const file = yield* Schema.decodeEffect(PackageText)(text).pipe(Effect.mapError(invalid));

    const record = (key: string) =>
      Option.getOrElse(
        Option.flatMap(Record.get(file, key), Schema.decodeUnknownOption(Dependencies)),
        () => ({}),
      );

    const dependencies = Option.map(
      Option.flatMap(Record.get(file, "dependencies"), Schema.decodeUnknownOption(Dependencies)),
      (declared) => Record.filter(declared, (_, name) => !Record.has(BUNDLED_PACKAGES, name)),
    );

    const engines = Option.liftPredicate(
      { ...record("engines"), chernabog: THIS_FLOOR },
      () => raiseFloor,
    );

    const pinned = {
      ...file,
      ...Object.fromEntries(Option.toArray(Option.map(engines, (raised) => ["engines", raised]))),
      ...Object.fromEntries(
        Option.toArray(Option.map(dependencies, (kept) => ["dependencies", kept])),
      ),
      devDependencies: { ...record("devDependencies"), ...BUNDLED_PACKAGES },
    };

    return Option.some(
      `${yield* Schema.encodeEffect(PackageText)(pinned).pipe(Effect.mapError(invalid))}\n`,
    );
  });

// Installs what a snapshot's flows and steps import beyond the bundled
// packages, with this binary acting as bun: only `dependencies`, at the
// lockfile's versions, without install scripts, which nobody reviewed when
// they trusted the tree. Nothing to do without dependencies.
export const installFlowDependencies = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/package.json`;

    if (!(yield* fs.exists(path))) {
      return;
    }

    const manifest = yield* decodeManifest(yield* fs.readFileString(path));

    if (Record.isEmptyRecord(manifest.dependencies ?? {})) {
      return;
    }

    const locked = yield* Effect.forEach(LOCKFILES, (lockfile) =>
      fs.exists(`${configDir}/${lockfile}`),
    );

    if (!locked.some(Boolean)) {
      return yield* new ConfigError({
        message: `.chernabog/package.json has dependencies but no lockfile; install them in .chernabog/ and commit its ${LOCKFILES.join(", ")}`,
      });
    }

    const host = yield* HostEnvironment;

    const result = yield* (yield* Exec).run(
      bunExecutable(),
      ["install", "--production", "--frozen-lockfile", "--ignore-scripts"],
      {
        cwd: configDir,
        env: { ...host.variables, BUN_BE_BUN: "1" },
        timeout: "5 minutes",
      },
    );

    if (result.exitCode !== 0) {
      const said = Arr.takeRight(`${result.stdout}\n${result.stderr}`.trim().split("\n"), 5).join(
        "\n",
      );

      return yield* new ConfigError({
        message: `installing .chernabog/'s dependencies failed:\n${said}`,
      });
    }
  }).pipe(
    Effect.catchTag("ExecError", (error) =>
      Effect.fail(
        new ConfigError({ message: `installing .chernabog/'s dependencies: ${error.message}` }),
      ),
    ),
  );
