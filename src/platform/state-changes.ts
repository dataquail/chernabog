// Noticing another process change the files chernabog keeps its state in.
// The daemon hears its own changes on its event bus; a person editing machine
// config, paused.json or trust.json by hand, or another chernabog process
// writing them, says nothing there. A watch on the home tells it something
// changed, and the file's identity tells it whether this process wrote it.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

// What a file is now: the file its path resolves to, its inode, size and
// when it last changed. A replace (as updateFile does, or an editor that
// saves by renaming) gives a new inode; an edit in place, a new time or size.
// None while it can't be read, as when it doesn't exist.
const identityOf = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    const real = yield* fs.realPath(path);
    const info = yield* fs.stat(real);
    const modified = Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() });

    return Option.some(`${real}:${String(info.ino)}:${String(info.size)}:${String(modified)}`);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const sameIdentity = Option.makeEquivalence((a: string, b: string) => a === b);

// How many of its own writes a process remembers: more than it makes between
// two checks of a watch, which come a second apart.
const REMEMBERED = 256;

// The identities of the files this process wrote, newest last. Shared by the
// process, as the files are.
const ownWrites = new Set<string>();

// Remembers the file at `path` as this process left it, so a watch in this
// process takes the change for its own. updateFile calls it after each write.
export const noteOwnWrite = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    for (const identity of Option.toArray(yield* identityOf(fs, path))) {
      ownWrites.add(identity);
    }

    for (const oldest of ownWrites) {
      if (ownWrites.size <= REMEMBERED) {
        break;
      }

      ownWrites.delete(oldest);
    }
  });

// Tells whether each of `paths` changed since it last looked, and whether
// another process changed it: a file as this process wrote it, or as it was
// when last looked at, is no change from elsewhere. It starts from the files
// as they are when made.
const makeForeignChanges = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const seen = new Map<string, Option.Option<string>>();

    for (const path of paths) {
      seen.set(path, yield* identityOf(fs, path));
    }

    return {
      // Whether `path` changed since it was last looked at, by another process.
      changedElsewhere: (path: string) =>
        Effect.gen(function* () {
          const now = yield* identityOf(fs, path);
          const before = seen.get(path) ?? Option.none();
          seen.set(path, now);

          if (sameIdentity(before, now)) {
            return false;
          }

          return Option.match(now, {
            // Removed: no process of chernabog's removes one of these.
            onNone: () => true,
            onSome: (identity) => !ownWrites.has(identity),
          });
        }),
    };
  });

// How long a watch gathers changes before it says them, so a burst of writes
// (a save, a run's steps) is said once.
export const STATE_CHANGE_WINDOW = Duration.seconds(1);

// The names, of `names`, of the files in `dir` that change, gathered over
// `window` from the first change: at most one batch a window. A watch that
// fails (the directory gone a moment, say) starts again a few seconds later,
// for a minute, then fails for its caller to say so.
const watchFiles = (
  dir: string,
  names: ReadonlyArray<string>,
  window: Duration.Input = STATE_CHANGE_WINDOW,
) =>
  Stream.unwrap(
    FileSystem.FileSystem.use((fs) =>
      Effect.succeed(
        fs.watch(dir).pipe(
          Stream.map((event) => event.path.slice(event.path.lastIndexOf("/") + 1)),
          Stream.filter((name) => names.includes(name)),
        ),
      ),
    ),
  ).pipe(
    Stream.retry(Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(12)])),
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, window),
    Stream.map((changed): ReadonlyArray<string> => [...new Set(changed)]),
  );

// What another process changed in `dir`, a batch at most each `window`: the
// names of `files`, which it tells by their identity, and of `database`, a
// SQLite file, whose `version` (its data_version on this process's
// connection) moves only for another connection's commits. Each change is
// looked at once its window is up, so the file is as that process left it.
export const watchStateChanges = <E, R>(options: {
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
  readonly database: {
    readonly name: string;
    readonly version: Effect.Effect<number, E, R>;
  };
  readonly window?: Duration.Input;
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { database, dir, files } = options;
      const pathOf = (name: string) => `${dir}/${name}`;
      const foreign = yield* makeForeignChanges(files.map(pathOf));
      let version = yield* database.version;

      // The database and the journal SQLite keeps beside it, as either mode does.
      const journals = [database.name, `${database.name}-wal`, `${database.name}-journal`];

      const elsewhere = (names: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const changed: Array<string> = [];

          for (const name of files.filter((file) => names.includes(file))) {
            if (yield* foreign.changedElsewhere(pathOf(name))) {
              changed.push(name);
            }
          }

          if (journals.some((journal) => names.includes(journal))) {
            const now = yield* database.version;

            if (now !== version) {
              version = now;
              changed.push(database.name);
            }
          }

          return changed;
        });

      return watchFiles(dir, [...files, ...journals], options.window).pipe(
        Stream.mapEffect(elsewhere),
        Stream.filter((changed) => changed.length > 0),
      );
    }),
  );
