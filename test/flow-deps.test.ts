import { BunServices } from '@effect/platform-bun';
import { describe, expect } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Result from 'effect/Result';

import { Exec, execOk } from '../src/Exec.ts';
import { installFlowDependencies } from '../src/flow-deps.ts';
import { bunExecutable } from '../src/self.ts';
import { effectAtHomeWith } from './effect-test.ts';

const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

// A .chernabog/ whose package.json depends on a package vendored beside it, so installing needs no registry.
const configDirWithDependency = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-deps-' });
  yield* fs.makeDirectory(`${dir}/vendor/greet`, { recursive: true });
  yield* fs.writeFileString(`${dir}/vendor/greet/package.json`, '{ "name": "greet", "version": "1.0.0", "type": "module", "main": "index.js" }');
  yield* fs.writeFileString(`${dir}/vendor/greet/index.js`, 'export const greet = (name) => `hello ${name}`;\n');
  yield* fs.writeFileString(`${dir}/package.json`, '{ "private": true, "dependencies": { "greet": "file:./vendor/greet" } }');

  return dir;
});

describe('flow dependencies', () => {
  effect('a .chernabog/ without dependencies installs nothing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-deps-' });
      yield* fs.writeFileString(`${dir}/package.json`, '{ "private": true, "devDependencies": { "effect": "4.0.5" } }');
      yield* installFlowDependencies(dir);
      expect(yield* fs.exists(`${dir}/node_modules`)).toBe(false);
    }),
  );

  effect('dependencies without a lockfile are refused', () =>
    Effect.gen(function* () {
      const dir = yield* configDirWithDependency;
      const installed = yield* Effect.result(installFlowDependencies(dir));
      expect(Result.isFailure(installed) && installed.failure.message).toContain('no lockfile');
    }),
  );

  effect("dependencies install at the lockfile's versions, and a lockfile out of step with package.json is refused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* configDirWithDependency;
      yield* execOk(bunExecutable(), ['install'], { cwd: dir });
      yield* fs.remove(`${dir}/node_modules`, { recursive: true });

      yield* installFlowDependencies(dir);
      expect(yield* fs.exists(`${dir}/node_modules/greet/index.js`)).toBe(true);

      yield* fs.writeFileString(`${dir}/package.json`, '{ "private": true, "dependencies": { "greet": "file:./vendor/greet", "other": "file:./vendor/greet" } }');
      const installed = yield* Effect.result(installFlowDependencies(dir));
      expect(Result.isFailure(installed) && installed.failure.message).toContain('failed');
    }),
  );
});
