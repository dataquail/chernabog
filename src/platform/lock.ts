// The workflow engine must run in exactly one process: in the spike, a second
// engine on the same database took over a workflow while the first was still
// alive. A lock file next to the database keeps a second one from starting.

import { describeError } from "@chernabog/sdk";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export class LockHeld extends Schema.TaggedError<LockHeld, { readonly brand: "LockHeld" }>()(
  "LockHeld",
  {
    message: Schema.String,
  },
) {}

const LockFile = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Finite, purpose: Schema.String, since: Schema.String }),
);

export type LockOwner = typeof LockFile.Type;

const held = (path: string, owner: Option.Option<LockOwner>) => {
  const who = Option.match(owner, {
    onNone: () => "another process",
    onSome: (found) => `pid ${found.pid} (${found.purpose})`,
  });

  return new LockHeld({
    message: `the workflow engine (${path}) is held by ${who}; stop it first, or go through the daemon`,
  });
};

// Signal 0 checks a process exists without touching it. EPERM means it exists but belongs to someone else.
const isAlive = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.succeed(Predicate.hasProperty(error.cause, "code") && error.cause.code === "EPERM"),
    ),
  );

// Where a lock file stands: there's none, a live process holds it, or it was
// left by a process that died (or is unreadable), with its text as read.
export type LockState = Data.TaggedEnum<{
  Free: Record<never, never>;
  Held: { readonly owner: LockOwner };
  Abandoned: { readonly text: string };
}>;

export const LockState = Data.taggedEnum<LockState>();

export const lockState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);

    if (Option.isNone(text)) {
      return LockState.Free();
    }

    const owner = Schema.decodeOption(LockFile)(text.value);

    if (Option.isSome(owner) && (yield* isAlive(owner.value.pid))) {
      return LockState.Held({ owner: owner.value });
    }

    return LockState.Abandoned({ text: text.value });
  });

// What a lock file says: this process holds it, for what, since now.
export const lockText = (purpose: string) =>
  Effect.gen(function* () {
    const since = DateTime.formatIso(yield* DateTime.now);

    return yield* Schema.encodeEffect(LockFile)({ pid: process.pid, purpose, since }).pipe(
      Effect.orDie,
    );
  });

// Creates the lock, unless it exists. It's written whole beside it and
// linked into place, so no process ever reads a lock half written, and takes
// a lock it can't read for one its holder abandoned.
export const createLock = (path: string, purpose: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staging = `${path}.${process.pid}.tmp`;
    yield* fs.writeFileString(staging, yield* lockText(purpose));

    return yield* fs.link(staging, path).pipe(
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
export const takeOverLock = (path: string, abandoned: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const aside = `${path}.${process.pid}.abandoned`;

    if (
      !(yield* fs.rename(path, aside).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ))
    ) {
      return;
    }

    if ((yield* fs.readFileString(aside)) !== abandoned) {
      yield* fs.link(aside, path).pipe(Effect.ignore);
    }

    yield* fs.remove(aside, { force: true });
  });

// How many times the engine's lock is tried while other processes are taking
// and releasing it, before it's reported held.
const TRIES = 5;

// Holds the lock for the scope's lifetime, failing at once while a live
// process holds it. A lock left by a process that died is taken over.
export const acquireLock = (path: string, purpose: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < TRIES; attempt++) {
        if (yield* createLock(path, purpose)) {
          return;
        }

        yield* LockState.$match(yield* lockState(path), {
          Free: () => Effect.void,
          Abandoned: ({ text }) => takeOverLock(path, text),
          Held: ({ owner }) => Effect.fail(held(path, Option.some(owner))),
        });
      }

      return yield* held(path, Option.none());
    }).pipe(
      Effect.catchTags({
        PlatformError: (error) => Effect.fail(new LockHeld({ message: describeError(error) })),
      }),
    ),
    () => FileSystem.FileSystem.use((fs) => fs.remove(path, { force: true })).pipe(Effect.ignore),
  );
