// The daemon runs committed flows and steps unattended, so anyone who can change
// .chernabog/ can run code on this machine. `chernabog trust` records the tree
// hash of the base branch's .chernabog/; if it changes after a pull, the repo
// pauses until someone reviews the change and trusts it again, as with
// `direnv allow`.

import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';

import { ConfigError, Home, homePaths } from './config.ts';
import { Exec, execOk } from './Exec.ts';

const TrustRecord = Schema.Struct({ tree: Schema.String, at: Schema.String });

const TrustFile = Schema.fromJsonString(Schema.Record(Schema.String, TrustRecord), { space: 2 });

export type TrustRecord = typeof TrustRecord.Type;

export const readTrust = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = homePaths((yield* Home).root).trust;

  if (!(yield* fs.exists(file))) return Record.empty<string, TrustRecord>();

  return Option.getOrElse(Schema.decodeOption(TrustFile)(yield* fs.readFileString(file)), () => Record.empty<string, TrustRecord>());
}).pipe(Effect.orElseSucceed(() => Record.empty<string, TrustRecord>()));

export const trustedTree = (slug: string) => readTrust.pipe(Effect.map((records) => Option.map(Record.get(records, slug), (record) => record.tree)));

export const recordTrust = (slug: string, tree: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const at = DateTime.formatIso(yield* DateTime.now);
    const records = { ...(yield* readTrust), [slug]: { tree, at } };
    yield* fs.makeDirectory(home.root, { recursive: true });
    yield* fs.writeFileString(homePaths(home.root).trust, `${yield* Schema.encodeEffect(TrustFile)(records)}\n`);
  }).pipe(Effect.mapError((error) => new ConfigError({ message: `trust.json: ${error.message}` })));

const listFiles = (path: string, tree: string) =>
  Effect.gen(function* () {
    const files = yield* execOk('git', ['-C', path, 'ls-tree', '-r', '--name-only', tree]);

    return `first trust; .chernabog/ holds:\n${files
      .trim()
      .split('\n')
      .map((file) => `  ${file}`)
      .join('\n')}`;
  });

// What changed in .chernabog/ since it was last trusted, or every file the first time.
export const trustDiff = (path: string, from: Option.Option<string>, to: string) =>
  Option.match(from, {
    onNone: () => listFiles(path, to),
    onSome: (previous) =>
      Effect.gen(function* () {
        const diff = yield* (yield* Exec).run('git', ['-C', path, 'diff', '--stat', '-p', previous, to]);

        if (diff.exitCode !== 0) return `could not diff ${previous}..${to} (${diff.stderr.trim()}); review .chernabog/ on the base branch`;

        if (diff.stdout.length === 0) return 'no changes';

        return diff.stdout;
      }),
  });
