// A repo's .chernabog/ is a package of its own. Its package.json pins
// @chernabog/sdk and effect, as dev dependencies, at the versions this binary
// bundles, so an editor types flows against what actually runs them; the loader
// substitutes the binary's copies at runtime whatever is installed. Anything
// else a flow or step imports goes in `dependencies` and is installed into each
// snapshot, so every repo, JS or not, declares its flows' packages the same way.

import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';

import SdkPackage from '../packages/sdk/package.json' with { type: 'json' };
import { ConfigError } from './config.ts';
import { EFFECT_VERSION } from './effect-modules.ts';
import { Exec } from './Exec.ts';
import { HostEnvironment } from './platform/environment.ts';
import { bunExecutable } from './self.ts';

// The packages the loader substitutes, at the versions it substitutes.
export const BUNDLED_PACKAGES: Readonly<Record<string, string>> = { '@chernabog/sdk': SdkPackage.version, effect: EFFECT_VERSION };

const Dependencies = Schema.Record(Schema.String, Schema.String);

const Manifest = Schema.Struct({ dependencies: Schema.optionalKey(Dependencies), devDependencies: Schema.optionalKey(Dependencies) });

export type Manifest = typeof Manifest.Type;

const ManifestText = Schema.fromJsonString(Manifest);

// The whole file, for rewriting the pins without losing the keys Manifest doesn't name.
const PackageText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json), { space: 2 });

const LOCKFILES = ['bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

const invalid = (error: { readonly message: string }) => new ConfigError({ message: `.chernabog/package.json: ${error.message}` });

export const decodeManifest = (text: string) => Schema.decodeEffect(ManifestText)(text).pipe(Effect.mapError(invalid));

// package.json for a new .chernabog/.
export const flowPackageText = () => `${Schema.encodeSync(PackageText)({ private: true, devDependencies: { ...BUNDLED_PACKAGES } })}\n`;

export type Drift = { readonly name: string; readonly wanted: string; readonly declared: Option.Option<string> };

// Each bundled package the manifest leaves out or pins to another version than this binary's.
export const pinDrift = (manifest: Manifest): ReadonlyArray<Drift> =>
  Record.toEntries(BUNDLED_PACKAGES).flatMap(([name, wanted]) => {
    const declared = Option.orElse(Record.get(manifest.dependencies ?? {}, name), () => Record.get(manifest.devDependencies ?? {}, name));

    if (Option.contains(declared, wanted)) return [];

    return [{ name, wanted, declared }];
  });

export const describeDrift = (drift: Drift) => Option.match(drift.declared, { onNone: () => `${drift.name} missing`, onSome: (declared) => `${drift.name} ${declared}, not ${drift.wanted}` });

// The same package.json with the bundled packages pinned to this binary's
// versions, as dev dependencies; none when they already are.
export const withBundledPins = (text: string) =>
  Effect.gen(function* () {
    const drift = pinDrift(yield* decodeManifest(text));

    if (drift.length === 0) return Option.none<string>();

    const file = yield* Schema.decodeEffect(PackageText)(text).pipe(Effect.mapError(invalid));

    const devDependencies = Option.getOrElse(Option.flatMap(Record.get(file, 'devDependencies'), Schema.decodeUnknownOption(Dependencies)), () => ({}));

    const dependencies = Option.map(Option.flatMap(Record.get(file, 'dependencies'), Schema.decodeUnknownOption(Dependencies)), (declared) =>
      Record.filter(declared, (_, name) => !Record.has(BUNDLED_PACKAGES, name)),
    );

    const pinned = { ...file, ...Object.fromEntries(Option.toArray(Option.map(dependencies, (kept) => ['dependencies', kept]))), devDependencies: { ...devDependencies, ...BUNDLED_PACKAGES } };

    return Option.some(`${yield* Schema.encodeEffect(PackageText)(pinned).pipe(Effect.mapError(invalid))}\n`);
  });

// Installs what a snapshot's flows and steps import beyond the bundled
// packages, with this binary acting as bun: only `dependencies`, at the
// lockfile's versions, without install scripts, which nobody reviewed when
// they trusted the tree. Nothing to do without dependencies.
export const installFlowDependencies = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/package.json`;

    if (!(yield* fs.exists(path))) return;

    const manifest = yield* decodeManifest(yield* fs.readFileString(path));

    if (Record.isEmptyRecord(manifest.dependencies ?? {})) return;

    const locked = yield* Effect.forEach(LOCKFILES, (lockfile) => fs.exists(`${configDir}/${lockfile}`));

    if (!locked.some(Boolean)) {
      return yield* new ConfigError({ message: `.chernabog/package.json has dependencies but no lockfile; install them in .chernabog/ and commit its ${LOCKFILES.join(', ')}` });
    }

    const host = yield* HostEnvironment;

    const result = yield* (yield* Exec).run(bunExecutable(), ['install', '--production', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: configDir,
      env: { ...host.variables, BUN_BE_BUN: '1' },
      timeout: '5 minutes',
    });

    if (result.exitCode !== 0) {
      const said = Arr.takeRight(`${result.stdout}\n${result.stderr}`.trim().split('\n'), 5).join('\n');

      return yield* new ConfigError({ message: `installing .chernabog/'s dependencies failed:\n${said}` });
    }
  }).pipe(Effect.catchTag('ExecError', (error) => Effect.fail(new ConfigError({ message: `installing .chernabog/'s dependencies: ${error.message}` }))));
