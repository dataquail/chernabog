// The workflow engine must run in exactly one process: in the spike, a second
// engine on the same database took over a workflow while the first was still
// alive. A lock file next to the database keeps a second one from starting.

import { describeError } from '@chernabog/sdk';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';

export class LockHeld extends Schema.TaggedError<LockHeld, { readonly brand: 'LockHeld' }>()('LockHeld', {
  message: Schema.String,
}) {}

const LockFile = Schema.fromJsonString(Schema.Struct({ pid: Schema.Finite, purpose: Schema.String, since: Schema.String }));

export type LockOwner = typeof LockFile.Type;

const held = (path: string, owner: Option.Option<LockOwner>) => {
  const who = Option.match(owner, { onNone: () => 'another process', onSome: (found) => `pid ${found.pid} (${found.purpose})` });

  return new LockHeld({ message: `the workflow engine (${path}) is held by ${who}; stop it first, or go through the daemon` });
};

// Signal 0 checks a process exists without touching it. EPERM means it exists but belongs to someone else.
const isAlive = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(Predicate.hasProperty(error.cause, 'code') && error.cause.code === 'EPERM')),
  );

// The process holding the lock, if it is still alive.
export const readLock = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(path))) return Option.none<LockOwner>();

    const owner = Schema.decodeOption(LockFile)(yield* fs.readFileString(path));

    if (Option.isNone(owner) || !(yield* isAlive(owner.value.pid))) return Option.none<LockOwner>();

    return owner;
  }).pipe(Effect.orElseSucceed(() => Option.none<LockOwner>()));

// Creates the lock file, unless it already exists.
const tryCreate = (path: string, purpose: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const since = DateTime.formatIso(yield* DateTime.now);
    const text = yield* Schema.encodeEffect(LockFile)({ pid: process.pid, purpose, since });

    return yield* fs.writeFileString(path, text, { flag: 'wx' }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, 'AlreadyExists'),
        () => Effect.succeed(false),
      ),
    );
  });

// Holds the lock for the scope's lifetime. A lock left by a process that died is taken over.
export const acquireLock = (path: string, purpose: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (yield* tryCreate(path, purpose)) return;

        const owner = yield* readLock(path);

        if (Option.isSome(owner)) return yield* held(path, owner);

        yield* fs.remove(path, { force: true });
      }

      return yield* held(path, Option.none());
    }).pipe(Effect.catchTags({ PlatformError: (error) => Effect.fail(new LockHeld({ message: describeError(error) })), SchemaError: (error) => Effect.die(error) })),
    () => FileSystem.FileSystem.use((fs) => fs.remove(path, { force: true })).pipe(Effect.ignore),
  );
