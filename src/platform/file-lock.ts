// Changing a file several processes change. Machine config, paused.json and
// trust.json are each read, changed and written back by the CLI, the TUI and
// the CLI's own migration at start; two at once would lose one change. An
// update holds a lock file beside the file while it reads, changes and
// replaces it, so chernabog's processes take turns. A person's editor takes no
// lock, so an update also checks the file is as it read it before replacing
// it, and reads it again if not.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { writeFileAtomic } from "./atomic-write.ts";
import { LockState, lockState, lockText } from "./lock.ts";

export class FileBusy extends Schema.TaggedError<FileBusy, { readonly brand: "FileBusy" }>()(
  "FileBusy",
  { message: Schema.String },
) {}

// How long an update waits for others to finish: each holds the lock for
// milliseconds, so a lock held this long belongs to a process that's stuck.
const PATIENCE = Duration.seconds(2);
const PAUSE = "20 millis";

// How many times an update reads the file again when an editor changed it
// under it, before its change wins anyway.
const REREADS = 3;

// The file a path names, through a symlink: the lock and the replacement go
// beside it, where the rename is atomic.
const targetOf = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    if (yield* fs.exists(path)) {
      return yield* fs.realPath(path);
    }

    return path;
  });

// Creates the lock, unless it exists. It's written whole beside it and
// linked into place, so no process ever reads a lock half written.
const tryLock = (fs: FileSystem.FileSystem, lock: string, purpose: string) =>
  Effect.gen(function* () {
    const staging = `${lock}.${process.pid}.tmp`;
    yield* fs.writeFileString(staging, yield* lockText(purpose));

    return yield* fs.link(staging, lock).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "AlreadyExists"),
        () => Effect.succeed(false),
      ),
      Effect.ensuring(fs.remove(staging, { force: true }).pipe(Effect.ignore)),
    );
  });

// Takes an abandoned lock away, only if it's still the one read: it's moved
// aside first, atomically, so a lock another process took meanwhile is never
// the one removed. One moved aside by mistake is put back.
const takeOver = (fs: FileSystem.FileSystem, lock: string, abandoned: string) =>
  Effect.gen(function* () {
    const aside = `${lock}.${process.pid}.abandoned`;

    if (
      !(yield* fs.rename(lock, aside).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ))
    ) {
      return;
    }

    if ((yield* fs.readFileString(aside)) !== abandoned) {
      yield* fs.link(aside, lock).pipe(Effect.ignore);
    }

    yield* fs.remove(aside, { force: true });
  });

const acquire = (fs: FileSystem.FileSystem, path: string, lock: string, purpose: string) =>
  Effect.gen(function* () {
    const stateOf = lockState(lock).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(PATIENCE);
    let owner = "another process";

    while ((yield* Clock.currentTimeMillis) < until) {
      if (yield* tryLock(fs, lock, purpose)) {
        return;
      }

      // Released meanwhile: try again at once. A live holder is waited for;
      // a dead one's lock is taken over.
      yield* LockState.$match(yield* stateOf, {
        Free: () => Effect.void,
        Abandoned: ({ text }) => takeOver(fs, lock, text),
        Held: (held) =>
          Effect.sync(() => {
            owner = `pid ${held.owner.pid} (${held.owner.purpose})`;
          }).pipe(Effect.andThen(Effect.sleep(PAUSE))),
      });
    }

    return yield* new FileBusy({
      message: `${path} is being changed by ${owner}; try again once it's done`,
    });
  });

// Runs `effect` holding the lock beside `path`. Not reentrant: an update
// inside another on the same file waits for itself, then fails.
export const withFileLock = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: string,
  purpose: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const lock = `${yield* targetOf(fs, path)}.lock`;

    return yield* Effect.acquireUseRelease(
      acquire(fs, path, lock, purpose),
      () => effect,
      () => fs.remove(lock, { force: true }).pipe(Effect.ignore),
    );
  });

const readIfExists = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(path))) {
      return Option.none<string>();
    }

    return Option.some(yield* fs.readFileString(path));
  });

const sameText = Option.makeEquivalence((a: string, b: string) => a === b);

// Updates a file under its lock: `change` gets its text (none when it doesn't
// exist) and returns a result and the text to replace it with, or none to
// leave it. When the file changed while `change` ran, as an editor saving it
// would, `change` runs again on what's there now, so that edit isn't lost.
export const updateFile = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: string,
  purpose: string,
  change: (
    current: Option.Option<string>,
  ) => Effect.Effect<readonly [A, Option.Option<string>], E, R>,
) =>
  withFileLock(
    fs,
    path,
    purpose,
    Effect.gen(function* () {
      let current = yield* readIfExists(fs, path);
      let [result, next] = yield* change(current);

      for (let reread = 0; reread < REREADS && Option.isSome(next); reread++) {
        const now = yield* readIfExists(fs, path);

        if (sameText(now, current)) {
          break;
        }

        current = now;
        [result, next] = yield* change(current);
      }

      for (const text of Option.toArray(next)) {
        yield* writeFileAtomic(fs, path, text);
      }

      return result;
    }),
  );
