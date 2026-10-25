// A repo's .chernabog/ is a package of its own. Its package.json pins
// @chernabog/sdk and effect, as dev dependencies, at the versions this binary
// bundles, so an editor types flows against what actually runs them; the loader
// substitutes the binary's copies at runtime whatever is installed. Anything
// else a flow or step imports goes in `dependencies` and is installed into each
// snapshot, so every repo, JS or not, declares its flows' packages the same way.
// The SDK pin is also the repo's one version fact: the SDK its flows were
// written against. This binary decides whether it runs that
// (src/kernel/sdk-support.value-object.ts), and refuses a repo it doesn't.

import * as Sdk from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import SdkPackage from "../../packages/sdk/package.json" with { type: "json" };
import { pinnedVersion, sdkSupport, supportedRange } from "../kernel/sdk-support.value-object.ts";
import { ConfigError, IncompatibleConfig } from "./config-error.ts";
import { EFFECT_VERSION } from "./effect-modules.ts";
import { HostEnvironment } from "./environment.ts";
import { Exec } from "./exec.ts";
import { bunExecutable } from "./self.ts";
import { VERSION } from "./version.ts";

export const SDK_PACKAGE = "@chernabog/sdk";

// The version of the SDK this binary bundles, which a run started here runs under.
export const BUNDLED_SDK = SdkPackage.version;

// The packages the loader substitutes, at the versions it substitutes.
export const BUNDLED_PACKAGES: Readonly<Record<string, string>> = {
  [SDK_PACKAGE]: BUNDLED_SDK,
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

// The command that moves a repo's flows to this binary's SDK.
export const UPGRADE_COMMAND = "chernabog recipes upgrade";

const invalid = (error: { readonly message: string }) =>
  new ConfigError({ message: `.chernabog/package.json: ${error.message}` });

export const decodeManifest = (text: string) =>
  Schema.decodeEffect(ManifestText)(text).pipe(Effect.mapError(invalid));

// package.json for a new .chernabog/.
export const flowPackageText = () =>
  `${Schema.encodeSync(PackageText)({ private: true, devDependencies: { ...BUNDLED_PACKAGES } })}\n`;

const declared = (manifest: Manifest, name: string) =>
  Option.orElse(Record.get(manifest.dependencies ?? {}, name), () =>
    Record.get(manifest.devDependencies ?? {}, name),
  );

// The SDK version the repo's flows were written against, as its pin says;
// none when it doesn't pin one.
export const sdkPin = (manifest: Manifest) => declared(manifest, SDK_PACKAGE);

const incompatible = (message: string) =>
  new IncompatibleConfig({ message: `.chernabog/: ${message}` });

// Why this binary can't run a repo with this manifest; none when it can.
export const incompatibility = (manifest: Manifest): Option.Option<string> => {
  if (Record.has(manifest.engines ?? {}, "chernabog")) {
    return Option.some(
      `package.json still has engines.chernabog, which chernabog no longer reads (the SDK pin says which chernabog runs it); run ${UPGRADE_COMMAND} and commit the result`,
    );
  }

  const pin = sdkPin(manifest);

  if (Option.isNone(pin)) {
    return Option.some(
      `package.json doesn't pin ${SDK_PACKAGE}, so nothing says which SDK its flows were written against; run ${UPGRADE_COMMAND} and commit the result`,
    );
  }

  const version = pinnedVersion(pin.value);

  if (Option.isNone(version)) {
    return Option.some(
      `package.json pins ${SDK_PACKAGE} to "${pin.value}"; it must be the version its flows were written against, such as "${BUNDLED_SDK}"`,
    );
  }

  const written = `its flows are written against ${SDK_PACKAGE} ${version.value}, and chernabog ${VERSION} runs ${supportedRange}`;

  switch (sdkSupport(version.value)) {
    case "older": {
      return Option.some(
        `${written}; move the flows with ${UPGRADE_COMMAND} and commit the result`,
      );
    }

    case "newer": {
      return Option.some(`${written}; upgrade chernabog`);
    }

    case "supported": {
      return Option.none();
    }
  }
};

// Whether the manifest's flows are written against a newer SDK than this
// binary runs, so it must not move them: back would break them.
export const writtenForNewer = (manifest: Manifest) =>
  Option.exists(
    Option.flatMap(sdkPin(manifest), pinnedVersion),
    (version) => sdkSupport(version) === "newer",
  );

// Fails when this binary can't run a repo with this manifest.
export const checkSdkPin = (manifest: Manifest) =>
  Option.match(incompatibility(manifest), {
    onNone: () => Effect.void,
    onSome: (message) => Effect.fail(incompatible(message)),
  });

const transpiler = new Bun.Transpiler({ loader: "ts" });

const IMPORT_FROM_SDK = /(?:import|export)\s*([^;]*?)\s*from\s*["']@chernabog\/sdk["']/g;
const NAMESPACE = /^\*\s*as\s+([\w$]+)$/;
const BRACES = /\{([^}]*)\}/s;
const DEFAULT = /^([\w$]+)\s*(?:,|$)/;

// What the bundled SDK exports.
const EXPORTED: ReadonlySet<string> = new Set(Object.keys(Sdk));

// The SDK's namespaces, such as Review, by name, with what each exports: a
// flow reaches their members by name, as Review.recheck.
const NAMESPACES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(Sdk).flatMap(([name, value]) => {
    if (Object.prototype.toString.call(value) !== "[object Module]" || !Predicate.isObject(value)) {
      return [];
    }

    return [[name, new Set(Object.keys(value))] as const];
  }),
);

const groupOf = (pattern: RegExp, text: string) =>
  Option.flatMap(Option.fromNullishOr(pattern.exec(text)), (match) =>
    Option.fromUndefinedOr(match[1]),
  );

// `a, b as c`, the names a clause imports, each with the local name it's bound to.
const named = (clause: string): ReadonlyArray<readonly [string, string]> =>
  clause.split(",").flatMap((part) => {
    const [name, local] = part.trim().split(/\s+as\s+/);

    if (Predicate.isUndefined(name) || name.length === 0) {
      return [];
    }

    return [[name, Option.getOrElse(Option.fromUndefinedOr(local), () => name)] as const];
  });

const escape = (name: string) => name.replace(/[.$]/g, "\\$&");

// The members a module reaches through a binding, as `binding.member`.
const membersOf = (code: string, binding: string) =>
  Arr.dedupe(
    [...code.matchAll(new RegExp(`(?<![\\w$.])${escape(binding)}\\.([\\w$]+)`, "g"))].flatMap(
      (match) => Option.toArray(Option.fromUndefinedOr(match[1])),
    ),
  );

// An SDK export a module names, bound to `binding`, if the SDK lacks it; or
// else the members of it the module reaches that it lacks, for a namespace.
const missingExport = (code: string, name: string, binding: string): ReadonlyArray<string> => {
  if (!EXPORTED.has(name)) {
    return [name];
  }

  return Option.match(Option.fromUndefinedOr(NAMESPACES.get(name)), {
    onNone: () => [],
    onSome: (members) =>
      membersOf(code, binding)
        .filter((member) => !members.has(member))
        .map((member) => `${name}.${member}`),
  });
};

// What one import clause of the SDK names that the SDK lacks: `* as Sdk`, a
// default, or `{ a, b as c }`.
const missingInClause = (code: string, clause: string) =>
  Option.match(groupOf(NAMESPACE, clause), {
    onSome: (namespace) =>
      membersOf(code, namespace).flatMap((name) =>
        missingExport(code, name, `${namespace}.${name}`),
      ),
    onNone: () => [
      ...Option.toArray(groupOf(DEFAULT, clause)).flatMap((local) =>
        missingExport(code, "default", local),
      ),
      ...named(Option.getOrElse(groupOf(BRACES, clause), () => "")).flatMap(([name, local]) =>
        missingExport(code, name, local),
      ),
    ],
  });

// What a module imports from the SDK that this binary's SDK doesn't export: a
// named import, or a member of one of its namespaces, such as
// Review.fixTrigger. Read from the module's code with its types stripped, so
// type-only imports, which never run, don't count.
export const missingSdkImports = (source: string): ReadonlyArray<string> => {
  const code = transpiler.transformSync(source);

  return Arr.dedupe(
    [...code.matchAll(IMPORT_FROM_SDK)].flatMap((match) =>
      Option.toArray(Option.fromUndefinedOr(match[1])).flatMap((clause) =>
        missingInClause(code, clause.trim()),
      ),
    ),
  );
};

const MODULE = /\.(?:ts|js|mts|mjs)$/;

// The flow and step modules in a .chernabog/, by path under it.
const modulesIn = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: Array<string> = [];

    for (const folder of ["flows", "stages"]) {
      if (!(yield* fs.exists(`${configDir}/${folder}`))) {
        continue;
      }

      for (const file of yield* fs.readDirectory(`${configDir}/${folder}`)) {
        if (MODULE.test(file) && !file.endsWith(".d.ts") && !file.includes(".test.")) {
          found.push(`${folder}/${file}`);
        }
      }
    }

    return Arr.sort(found, Order.String);
  });

// Fails when a flow or step imports from the SDK something this binary's SDK
// doesn't export, before any of them is loaded or run.
export const checkSdkImports = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const problems: Array<string> = [];

    for (const file of yield* modulesIn(configDir)) {
      const missing = missingSdkImports(yield* fs.readFileString(`${configDir}/${file}`));

      if (missing.length > 0) {
        problems.push(`${file} (${missing.join(", ")})`);
      }
    }

    if (problems.length > 0) {
      return yield* incompatible(
        `flows import what ${SDK_PACKAGE} ${BUNDLED_SDK} doesn't export: ${problems.join("; ")}; move them with ${UPGRADE_COMMAND}, or rewrite them by hand, and commit the result`,
      );
    }
  });

// Checks this binary can run the .chernabog/ in `configDir`, before anything
// else in it is read: its SDK pin is in the range this binary runs, and its
// flows import only what the bundled SDK has.
export const checkCompatibility = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/package.json`;

    if (!(yield* fs.exists(path))) {
      return yield* incompatible(
        `it has no package.json pinning ${SDK_PACKAGE}, so nothing says which SDK its flows were written against; run ${UPGRADE_COMMAND} and commit the result`,
      );
    }

    yield* checkSdkPin(yield* decodeManifest(yield* fs.readFileString(path)));
    yield* checkSdkImports(configDir);
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: `.chernabog/: ${error.message}` })),
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
    const pin = declared(manifest, name);

    if (Option.contains(pin, wanted)) {
      return [];
    }

    return [{ name, wanted, declared: pin }];
  });

export const describeDrift = (drift: Drift) =>
  Option.match(drift.declared, {
    onNone: () => `${drift.name} missing`,
    onSome: (pin) => `${drift.name} ${pin}, not ${drift.wanted}`,
  });

// The same package.json with the bundled packages pinned to this binary's
// versions, as dev dependencies, and engines.chernabog, which no chernabog
// reads any more, dropped; none when nothing changes.
export const withBundledPins = (text: string) =>
  Effect.gen(function* () {
    const manifest = yield* decodeManifest(text);
    const drift = pinDrift(manifest);
    const floor = Record.has(manifest.engines ?? {}, "chernabog");

    if (drift.length === 0 && !floor) {
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
      (declaredHere) =>
        Record.filter(declaredHere, (_, name) => !Record.has(BUNDLED_PACKAGES, name)),
    );

    const engines = Record.remove(record("engines"), "chernabog");

    const pinned = {
      ...Record.remove(file, "engines"),
      ...Object.fromEntries(
        Option.toArray(
          Option.map(
            Option.liftPredicate(engines, (left) => !Record.isEmptyRecord(left)),
            (left) => ["engines", left],
          ),
        ),
      ),
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
