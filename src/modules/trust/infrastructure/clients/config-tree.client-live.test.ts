import { BunServices } from '@effect/platform-bun';
import { describe, expect } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';

import { effectAtHomeWith } from '../../../../../test/effect-test.ts';
import { Exec, execOk } from '../../../../Exec.ts';
import { ConfigTreeClient } from '../../domain/ports/clients/config-tree.client.ts';
import { ConfigTreeClientLive } from './config-tree.client-live.ts';

// A repo on main with .chernabog/ committed, and a client over it.
const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-trust-' });
  const git = (...args: ReadonlyArray<string>) => execOk('git', ['-C', path, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  yield* git('init', '--quiet', '--initial-branch', 'main');
  yield* fs.makeDirectory(`${path}/.chernabog/flows`, { recursive: true });
  yield* fs.writeFileString(`${path}/.chernabog/config.yaml`, 'baseBranch: main\n');
  yield* fs.writeFileString(`${path}/.chernabog/flows/implement.ts`, 'export {};\n');
  yield* git('add', '.');
  yield* git('commit', '--quiet', '-m', 'init');

  return { fs, git, path, client: yield* ConfigTreeClient };
}).pipe(Effect.provide(ConfigTreeClientLive));

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe('ConfigTreeClientLive', () => {
  effect('reads the tree of .chernabog/ on the base branch, and lists every file the first time', () =>
    Effect.gen(function* () {
      const { client, path } = yield* checkout;
      const tree = yield* client.treeOf(path, 'main');

      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      expect(yield* client.changesSince(path, Option.none(), tree)).toBe('first trust; .chernabog/ holds:\n  config.yaml\n  flows/implement.ts');
    }),
  );

  effect('shows what changed since the tree trusted before, or that nothing did', () =>
    Effect.gen(function* () {
      const { client, fs, git, path } = yield* checkout;
      const before = yield* client.treeOf(path, 'main');
      yield* fs.writeFileString(`${path}/.chernabog/config.yaml`, 'baseBranch: trunk\n');
      yield* git('commit', '--quiet', '-am', 'change');
      const after = yield* client.treeOf(path, 'main');

      expect(yield* client.changesSince(path, Option.some(before), after)).toContain('-baseBranch: main\n+baseBranch: trunk');
      expect(yield* client.changesSince(path, Option.some(after), after)).toBe('no changes');
    }),
  );

  effect('fails saying what to do when the base branch has no .chernabog/', () =>
    Effect.gen(function* () {
      const { client, path } = yield* checkout;
      const refused = yield* Effect.flip(client.treeOf(path, 'nope'));

      expect(refused.message).toBe(`${path}: no .chernabog/ on nope; run chernabog init and merge it first`);
    }),
  );
});
