// A repo's .chernabog/ is a package of its own. Its flows are written from
// @chernabog/sdk, the blocks, which it lists in `dependencies` at the version
// it chooses, so each snapshot installs its own copy; the loader resolves the
// SDK from there. @chernabog/core and effect it pins as dev dependencies, at
// the versions this binary bundles, so an editor types flows against what
// actually runs them: the loader substitutes the binary's copies of those two
// at runtime, whatever is installed. Anything else a flow or step imports goes
// in `dependencies` too, so every repo, JS or not, declares its flows'
// packages the same way.
// The installed SDK's peer range on core is the repo's one version fact: the
// core its flows need. This binary decides whether it provides one in it
// (src/kernel/core-support.value-object.ts), and refuses a repo it doesn't.

import * as Core from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import CorePackage from "../../packages/core/package.json" with { type: "json" };
import SdkPackage from "../../packages/sdk/package.json" with { type: "json" };
import {
  type CoreSupport,
  coreSupport,
  pinnedVersion,
  providedRange,
} from "../kernel/core-support.value-object.ts";
import {
  parseRecipeRef,
  RecipePackageManifest,
  SDK_PACKAGE,
} from "../kernel/recipe-package.value-object.ts";
import { ConfigError, IncompatibleConfig } from "./config-error.ts";
import { EFFECT_VERSION } from "./effect-modules.ts";
import { HostEnvironment } from "./environment.ts";
import { Exec } from "./exec.ts";
import { flowImports, packageDirOf, type PackageOverrides } from "./flow-loader.ts";
import { bunExecutable } from "./self.ts";
import { VERSION } from "./version.ts";

export { SDK_PACKAGE };

export const CORE_PACKAGE = "@chernabog/core";

// The version of core this binary bundles, which a run started here runs under.
export const BUNDLED_CORE = CorePackage.version;

// The SDK released beside this binary: what init and recipes upgrade pin a
// repo to. This binary doesn't run it; a repo's snapshot installs its own.
export const RELEASED_SDK = SdkPackage.version;

// The packages the loader substitutes, at the versions it substitutes.
export const BUNDLED_PACKAGES: Readonly<Record<string, string>> = {
  [CORE_PACKAGE]: BUNDLED_CORE,
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

// The command that moves a repo's flows to this binary's core and the SDK released with it.
export const UPGRADE_COMMAND = "chernabog recipes upgrade";

const invalid = (error: { readonly message: string }) =>
  new ConfigError({ message: `.chernabog/package.json: ${error.message}` });

export const decodeManifest = (text: string) =>
  Schema.decodeEffect(ManifestText)(text).pipe(Effect.mapError(invalid));

// package.json for a new .chernabog/.
export const flowPackageText = () =>
  `${Schema.encodeSync(PackageText)({
    private: true,
    dependencies: { [SDK_PACKAGE]: RELEASED_SDK },
    devDependencies: { ...BUNDLED_PACKAGES },
  })}\n`;

const declared = (manifest: Manifest, name: string) =>
  Option.orElse(Record.get(manifest.dependencies ?? {}, name), () =>
    Record.get(manifest.devDependencies ?? {}, name),
  );

// The SDK the repo's flows are written from, as its dependencies pin it; none
// when it doesn't list one there.
export const sdkPin = (manifest: Manifest) => Record.get(manifest.dependencies ?? {}, SDK_PACKAGE);

// How the core the repo's flows are typed against, as its dev pin says,
// stands against what this binary provides; none without an exact pin.
const corePinSupport = (manifest: Manifest) =>
  Option.map(
    Option.flatMap(declared(manifest, CORE_PACKAGE), pinnedVersion),
    (version) => [version, coreSupport(`^${version}`)] as const,
  );

const incompatible = (message: string) =>
  new IncompatibleConfig({ message: `.chernabog/: ${message}` });

// Why this binary can't run a repo with this manifest, read before anything
// is installed; none when nothing in it says so.
export const incompatibility = (manifest: Manifest): Option.Option<string> => {
  if (Record.has(manifest.engines ?? {}, "chernabog")) {
    return Option.some(
      `package.json still has engines.chernabog, which chernabog no longer reads; run ${UPGRADE_COMMAND} and commit the result`,
    );
  }

  if (Option.isNone(sdkPin(manifest))) {
    return Option.some(
      `package.json doesn't list ${SDK_PACKAGE} in dependencies, so no snapshot installs the blocks its flows are written from; run ${UPGRADE_COMMAND} and commit the result`,
    );
  }

  for (const [version, support] of Option.toArray(corePinSupport(manifest))) {
    const typed = `its flows are typed against ${CORE_PACKAGE} ${version}, and chernabog ${VERSION} provides ${providedRange}`;

    if (support === "newer") {
      return Option.some(`${typed}; upgrade chernabog`);
    }

    if (support === "older") {
      return Option.some(`${typed}; move them with ${UPGRADE_COMMAND} and commit the result`);
    }
  }

  return Option.none();
};

// Whether the manifest's flows are typed against a newer core than this
// binary provides, so it must not move them: back would break them.
export const writtenForNewer = (manifest: Manifest) =>
  Option.exists(corePinSupport(manifest), ([, support]) => support === "newer");

// Fails when the manifest says this binary can't run the repo.
export const checkManifest = (manifest: Manifest) =>
  Option.match(incompatibility(manifest), {
    onNone: () => Effect.void,
    onSome: (message) => Effect.fail(incompatible(message)),
  });

const transpiler = new Bun.Transpiler({ loader: "ts" });

const IMPORT_FROM_CORE = /(?:import|export)\s*([^;]*?)\s*from\s*["']@chernabog\/core["']/g;
const NAMESPACE = /^\*\s*as\s+([\w$]+)$/;
const BRACES = /\{([^}]*)\}/s;
const DEFAULT = /^([\w$]+)\s*(?:,|$)/;

// What the bundled core exports.
const EXPORTED: ReadonlySet<string> = new Set(Object.keys(Core));

// Core's namespaces, such as Claims, by name, with what each exports: a flow
// reaches their members by name, as Claims.releasing.
const NAMESPACES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(Core).flatMap(([name, value]) => {
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

// A binding as a literal in a pattern, every character special to one escaped.
const escape = (name: string) => name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

// The members a module reaches through a binding, as `binding.member`.
const membersOf = (code: string, binding: string) =>
  Arr.dedupe(
    [...code.matchAll(new RegExp(`(?<![\\w$.])${escape(binding)}\\.([\\w$]+)`, "g"))].flatMap(
      (match) => Option.toArray(Option.fromUndefinedOr(match[1])),
    ),
  );

// A core export a module names, bound to `binding`, if core lacks it; or else
// the members of it the module reaches that it lacks, for a namespace.
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

// What one import clause of core names that core lacks: `* as Core`, a
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

// What a module imports straight from core that this binary's core doesn't
// export: a named import, or a member of one of its namespaces, such as
// Claims.releasing. Read from the module's code with its types stripped, so
// type-only imports, which never run, don't count. What it imports from the
// SDK is the installed SDK's business, which checkInstalled checks.
export const missingCoreImports = (source: string): ReadonlyArray<string> => {
  const code = transpiler.transformSync(source);

  return Arr.dedupe(
    [...code.matchAll(IMPORT_FROM_CORE)].flatMap((match) =>
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

// Fails when a flow or step imports from core something this binary's core
// doesn't export, before any of them is loaded or run.
export const checkCoreImports = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const problems: Array<string> = [];

    for (const file of yield* modulesIn(configDir)) {
      const missing = missingCoreImports(yield* fs.readFileString(`${configDir}/${file}`));

      if (missing.length > 0) {
        problems.push(`${file} (${missing.join(", ")})`);
      }
    }

    if (problems.length > 0) {
      return yield* incompatible(
        `flows import what ${CORE_PACKAGE} ${BUNDLED_CORE} doesn't export: ${problems.join("; ")}; move them with ${UPGRADE_COMMAND}, or rewrite them by hand, and commit the result`,
      );
    }
  });

// Checks what can be checked of the .chernabog/ in `configDir` before
// anything in it is installed or read: its manifest lists the SDK and pins a
// core this binary provides, and its flows import only what the bundled core
// has.
export const checkCompatibility = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/package.json`;

    if (!(yield* fs.exists(path))) {
      return yield* incompatible(
        `it has no package.json listing ${SDK_PACKAGE}, so nothing says which blocks its flows are written from; run ${UPGRADE_COMMAND} and commit the result`,
      );
    }

    yield* checkManifest(yield* decodeManifest(yield* fs.readFileString(path)));
    yield* checkCoreImports(configDir);
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: `.chernabog/: ${error.message}` })),
    ),
  );

// What the checks read of an installed package's package.json.
const InstalledManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    peerDependencies: Schema.optionalKey(Dependencies),
  }),
);

const InstalledRecipePackage = Schema.fromJsonString(RecipePackageManifest);

// The version bun.lock pins a package at; none without a lockfile, or one that
// doesn't name it.
const lockedVersion = (lockfile: string, name: string) =>
  Option.flatMap(
    Option.fromNullishOr(
      new RegExp(`"${escape(name)}": \\["${escape(name)}@([^"]+)"`).exec(lockfile),
    ),
    (match) => Option.fromUndefinedOr(match[1]),
  );

// Why an installed package isn't the version bun.lock pins; none when it is,
// or there's no bun.lock.
const lockProblem = (configDir: string, name: string, installed: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockfile = `${configDir}/bun.lock`;

    if (!(yield* fs.exists(lockfile))) {
      return Option.none<string>();
    }

    return Option.map(
      Option.filter(
        lockedVersion(yield* fs.readFileString(lockfile), name),
        (version) => version !== installed,
      ),
      (pinned) =>
        `${name} is installed at ${installed}, and bun.lock pins ${pinned}; run bun install in .chernabog/`,
    );
  });

// What to do about a range of core this binary doesn't provide, by which side is behind.
const coreAdvice = (support: CoreSupport, older: string) => {
  if (support === "newer") {
    return "upgrade chernabog";
  }

  return older;
};

// The installed SDK's version, or why this binary can't run it: it isn't
// installed, isn't the version bun.lock pins, or needs a core this binary
// doesn't provide.
const installedSdk = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/node_modules/${SDK_PACKAGE}/package.json`;

    if (!(yield* fs.exists(path))) {
      return yield* incompatible(
        `${SDK_PACKAGE} isn't installed in .chernabog/; run bun install there`,
      );
    }

    const sdk = yield* Schema.decodeEffect(InstalledManifest)(yield* fs.readFileString(path)).pipe(
      Effect.mapError(
        (error) => new ConfigError({ message: `.chernabog/: ${SDK_PACKAGE}: ${error.message}` }),
      ),
    );

    for (const problem of Option.toArray(yield* lockProblem(configDir, SDK_PACKAGE, sdk.version))) {
      return yield* incompatible(problem);
    }

    const range = Option.fromUndefinedOr(sdk.peerDependencies?.[CORE_PACKAGE]);

    if (Option.isNone(range)) {
      return yield* incompatible(
        `${SDK_PACKAGE} ${sdk.version} declares no range of ${CORE_PACKAGE}, so nothing says which core its blocks need; run ${UPGRADE_COMMAND} and commit the result`,
      );
    }

    const support = coreSupport(range.value);

    if (support !== "supported") {
      return yield* incompatible(
        `its flows are written from ${SDK_PACKAGE} ${sdk.version}, which needs ${CORE_PACKAGE} ${range.value}, and chernabog ${VERSION} provides ${providedRange}; ${coreAdvice(support, `move .chernabog/ to a newer ${SDK_PACKAGE} with ${UPGRADE_COMMAND}`)}`,
      );
    }

    return sdk.version;
  });

// Why this binary can't run one package that a flow imports from: not a
// dependency (a snapshot installs only those), not installed, installed at
// another version than bun.lock pins, or written for another SDK than the
// repo's, or a core this binary doesn't provide. None when it can.
const importedPackageProblem = (
  configDir: string,
  manifest: Manifest,
  name: string,
  sdk: string,
  overrides: PackageOverrides,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A package read from a directory of its own is checked only for its ranges.
    const overridden = overrides.has(name);

    if (!overridden && !Record.has(manifest.dependencies ?? {}, name)) {
      return Option.some(
        `config.yaml imports flows from ${name}, which package.json doesn't list in dependencies (a snapshot installs only those); chernabog recipes add --import puts it there`,
      );
    }

    const path = `${packageDirOf(configDir, name, overrides)}/package.json`;

    if (!(yield* fs.exists(path))) {
      return Option.some(
        `config.yaml imports flows from ${name}, which isn't installed in .chernabog/; run bun install there`,
      );
    }

    const installed = yield* Schema.decodeEffect(InstalledRecipePackage)(
      yield* fs.readFileString(path),
    ).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `.chernabog/: ${name} isn't a recipe package: ${error.message}`,
          }),
      ),
    );

    if (!overridden) {
      for (const problem of Option.toArray(
        yield* lockProblem(configDir, name, installed.version),
      )) {
        return Option.some(problem);
      }
    }

    const sdkRange = Option.fromUndefinedOr(installed.peerDependencies?.[SDK_PACKAGE]);

    if (!Option.exists(sdkRange, (found) => Bun.semver.satisfies(sdk, found))) {
      return Option.some(
        `config.yaml imports flows from ${name} ${installed.version}, which supports ${SDK_PACKAGE} ${Option.getOrElse(sdkRange, () => "(no range declared)")}, and .chernabog/ has ${SDK_PACKAGE} ${sdk}; move one of them (chernabog recipes update moves ${name})`,
      );
    }

    for (const coreRange of Option.toArray(
      Option.fromUndefinedOr(installed.peerDependencies?.[CORE_PACKAGE]),
    )) {
      const support = coreSupport(coreRange);

      if (support !== "supported") {
        return Option.some(
          `config.yaml imports flows from ${name} ${installed.version}, which needs ${CORE_PACKAGE} ${coreRange}, and chernabog ${VERSION} provides ${providedRange}; ${coreAdvice(support, `move ${name} to a newer version (chernabog recipes update)`)}`,
        );
      }
    }

    return Option.none<string>();
  });

// Checks this binary can run the installed .chernabog/ in `configDir`: the SDK
// its flows are written from needs a core it provides, and every package a
// flow config.yaml imports comes from can run on that SDK and core. Fails
// naming the package. Read once the packages are installed.
export const checkInstalled = (configDir: string, overrides: PackageOverrides = new Map()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sdk = yield* installedSdk(configDir);

    const imports = yield* flowImports(configDir).pipe(
      Effect.mapError((error) => new ConfigError({ message: `.chernabog/: ${error.message}` })),
    );

    if (imports.size === 0) {
      return;
    }

    const manifest = yield* decodeManifest(yield* fs.readFileString(`${configDir}/package.json`));
    const names = Arr.dedupe([...imports.values()].map((from) => parseRecipeRef(from).package));

    for (const name of names) {
      for (const problem of Option.toArray(
        yield* importedPackageProblem(configDir, manifest, name, sdk, overrides),
      )) {
        return yield* incompatible(problem);
      }
    }
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: `.chernabog/: ${error.message}` })),
    ),
  );

// Checks this binary can run the installed .chernabog/ in `configDir`:
// checkCompatibility, then what's installed.
export const checkRunnable = (configDir: string, overrides: PackageOverrides = new Map()) =>
  Effect.andThen(checkCompatibility(configDir), checkInstalled(configDir, overrides));

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

// The SDK version a manifest should list: the one released with this binary,
// unless it lists that or a newer one already, which is the person's to move.
const sdkMove = (manifest: Manifest) =>
  Option.liftPredicate(
    RELEASED_SDK,
    () =>
      !Option.exists(
        Option.flatMap(sdkPin(manifest), pinnedVersion),
        (version) => Bun.semver.order(version, RELEASED_SDK) >= 0,
      ),
  );

// The same package.json with the bundled packages pinned to this binary's
// versions, as dev dependencies, the SDK in dependencies at least at the one
// released with it, and engines.chernabog, which no chernabog reads any more,
// dropped; none when nothing changes.
export const withBundledPins = (text: string) =>
  Effect.gen(function* () {
    const manifest = yield* decodeManifest(text);
    const drift = pinDrift(manifest);
    const floor = Record.has(manifest.engines ?? {}, "chernabog");
    const sdk = sdkMove(manifest);
    const sdkInDev = Record.has(manifest.devDependencies ?? {}, SDK_PACKAGE);

    if (drift.length === 0 && !floor && Option.isNone(sdk) && !sdkInDev) {
      return Option.none<string>();
    }

    const file = yield* Schema.decodeEffect(PackageText)(text).pipe(Effect.mapError(invalid));

    const record = (key: string) =>
      Option.getOrElse(
        Option.flatMap(Record.get(file, key), Schema.decodeUnknownOption(Dependencies)),
        () => ({}),
      );

    const dependencies = {
      ...Record.filter(record("dependencies"), (_, name) => !Record.has(BUNDLED_PACKAGES, name)),
      ...Object.fromEntries(Option.toArray(Option.map(sdk, (version) => [SDK_PACKAGE, version]))),
    };

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
      dependencies,
      devDependencies: {
        ...Record.remove(record("devDependencies"), SDK_PACKAGE),
        ...BUNDLED_PACKAGES,
      },
    };

    return Option.some(
      `${yield* Schema.encodeEffect(PackageText)(pinned).pipe(Effect.mapError(invalid))}\n`,
    );
  });

// Installs what a snapshot's flows and steps import beyond the bundled
// packages, the SDK among them, with this binary acting as bun: only
// `dependencies`, at the lockfile's versions, without install scripts, which
// nobody reviewed when they trusted the tree. Nothing to do without
// dependencies.
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
