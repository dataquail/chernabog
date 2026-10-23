import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { effect } from "../../test/effect-test.ts";
import { acquireLock } from "./lock.ts";

const scratch = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-engine-lock-" }),
);

describe("acquireLock", () => {
  effect("a second holder is refused, told who holds it, and the lock goes with its scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = `${yield* scratch}/engine.lock`;

      const refused = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireLock(lock, "daemon");

          return yield* Effect.flip(Effect.scoped(acquireLock(lock, "run review")));
        }),
      );

      expect(refused.message).toContain(`pid ${process.pid} (daemon)`);
      expect(yield* fs.exists(lock)).toBe(false);
    }),
  );

  effect("a lock its holder left when it died is taken over", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = `${yield* scratch}/engine.lock`;
      yield* fs.writeFileString(
        lock,
        JSON.stringify({ pid: 2 ** 22 + 1, purpose: "a crash", since: "2026-10-23T00:00:00Z" }),
      );

      yield* Effect.scoped(acquireLock(lock, "daemon"));
    }),
  );

  effect("a lock that can't be read, as one cut short, is taken over", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = `${yield* scratch}/engine.lock`;
      yield* fs.writeFileString(lock, "");

      yield* Effect.scoped(acquireLock(lock, "daemon"));
    }),
  );
});
