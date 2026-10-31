import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { effect } from "../../test/effect-test.ts";
import {
  capLog,
  DAEMON_LOG_RETENTION,
  daily,
  keepDayFolders,
  reported,
  type RetentionPolicy,
  sweepDayFolders,
  sweepRotatedLogs,
} from "./retention.ts";

const TODAY = "2026-10-31";

const scratch = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-retention-" }),
);

// A day folder (or any entry) under `dir`, holding one file of `bytes` bytes.
const folder = (dir: string, name: string, bytes = 1) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${dir}/${name}`, { recursive: true });
    yield* fs.writeFileString(`${dir}/${name}/daemon-1.jsonl`, "x".repeat(bytes));
  });

const entries = (dir: string) =>
  FileSystem.FileSystem.use((fs) => fs.readDirectory(dir)).pipe(
    Effect.map((names) => names.toSorted()),
  );

// On the test clock, which setToday puts at noon UTC on TODAY.
const atToday = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  test.pipe(Effect.provide(TestClock.layer()));

const setToday = TestClock.setTime(Date.parse(`${TODAY}T12:00:00Z`));

type Outcome = { readonly swept: ReadonlyArray<string> } | { readonly failed: unknown };

const ageOnly: RetentionPolicy = { maxAgeDays: 30, maxBytes: Number.MAX_SAFE_INTEGER };

describe("sweepDayFolders", () => {
  effect("removes day folders older than the policy's age, by name, and keeps newer ones", () =>
    atToday(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* setToday;

        for (const day of ["2026-09-01", "2026-09-30", "2026-10-01", "2026-10-30", TODAY]) {
          yield* folder(dir, day);
        }

        const removed = yield* sweepDayFolders(dir, ageOnly);

        expect(removed.toSorted()).toEqual(["2026-09-01", "2026-09-30"]);
        expect(yield* entries(dir)).toEqual(["2026-10-01", "2026-10-30", TODAY]);
      }),
    ),
  );

  effect("over the size cap, removes the oldest day folders first and never today's", () =>
    atToday(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* setToday;

        yield* folder(dir, "2026-10-28", 100);
        yield* folder(dir, "2026-10-29", 100);
        yield* folder(dir, "2026-10-30", 100);
        yield* folder(dir, TODAY, 100);

        const removed = yield* sweepDayFolders(dir, { maxAgeDays: 30, maxBytes: 250 });

        expect(removed).toEqual(["2026-10-28", "2026-10-29"]);
        expect(yield* entries(dir)).toEqual(["2026-10-30", TODAY]);
      }),
    ),
  );

  effect("keeps today's folder even when it alone is over the cap", () =>
    atToday(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* setToday;

        yield* folder(dir, "2026-10-30", 10);
        yield* folder(dir, TODAY, 500);

        yield* sweepDayFolders(dir, { maxAgeDays: 30, maxBytes: 100 });

        expect(yield* entries(dir)).toEqual([TODAY]);
      }),
    ),
  );

  effect("leaves entries whose names aren't a day alone, and doesn't count them", () =>
    atToday(
      Effect.gen(function* () {
        const dir = yield* scratch;
        const fs = yield* FileSystem.FileSystem;
        yield* setToday;

        yield* folder(dir, "2020-01-01");
        yield* folder(dir, "notes", 1000);
        yield* folder(dir, "2020-13-45");
        yield* folder(dir, "2020-01-01-old");
        yield* fs.writeFileString(`${dir}/README`, "x".repeat(1000));

        const removed = yield* sweepDayFolders(dir, { maxAgeDays: 30, maxBytes: 100 });

        expect(removed).toEqual(["2020-01-01"]);
        expect(yield* entries(dir)).toEqual(["2020-01-01-old", "2020-13-45", "README", "notes"]);
      }),
    ),
  );

  effect("a folder that doesn't exist yet is nothing to sweep", () =>
    atToday(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* setToday;

        expect(yield* sweepDayFolders(`${dir}/telemetry`, ageOnly)).toEqual([]);
      }),
    ),
  );
});

describe("keepDayFolders", () => {
  // Keeps `dir` on a fiber of its own, and hands each sweep's outcome to the
  // queue the test takes from, so it waits on the sweep's real file I/O.
  const keeping = (dir: string) =>
    Effect.gen(function* () {
      const outcomes = yield* Queue.unbounded<Outcome>();

      const fiber = yield* Effect.forkChild(
        keepDayFolders(dir, ageOnly, {
          swept: (removed) => Queue.offer(outcomes, { swept: removed }).pipe(Effect.asVoid),
          failed: (cause) => Queue.offer(outcomes, { failed: cause }).pipe(Effect.asVoid),
        }),
      );

      return { next: Queue.take(outcomes), stop: Fiber.interrupt(fiber) };
    });

  effect("sweeps at once, then again after 24 hours of the clock", () =>
    atToday(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* setToday;
        yield* folder(dir, "2026-09-01");

        const keeper = yield* keeping(dir);

        expect(yield* keeper.next).toEqual({ swept: ["2026-09-01"] });

        // 2026-10-01 turns 31 days old tomorrow, and goes with tomorrow's sweep.
        yield* folder(dir, "2026-09-30");
        yield* folder(dir, "2026-10-01");
        yield* TestClock.adjust("23 hours");
        expect(yield* entries(dir)).toEqual(["2026-09-30", "2026-10-01"]);

        yield* TestClock.adjust("1 hour");
        expect(yield* keeper.next).toEqual({ swept: ["2026-09-30", "2026-10-01"] });
        expect(yield* entries(dir)).toEqual([]);

        yield* keeper.stop;
      }),
    ),
  );

  effect("a failed sweep is reported, and the next day's tries again", () =>
    atToday(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = `${yield* scratch}/telemetry`;
        yield* setToday;

        // A file where the folder should be: reading it as one fails.
        yield* fs.writeFileString(dir, "not a folder");

        const keeper = yield* keeping(dir);

        expect(yield* keeper.next).toHaveProperty("failed");

        yield* fs.remove(dir);
        yield* folder(dir, "2026-09-01");
        yield* TestClock.adjust("24 hours");

        expect(yield* keeper.next).toEqual({ swept: ["2026-09-01"] });

        yield* keeper.stop;
      }),
    ),
  );
});

describe("daily", () => {
  effect("runs each of the day's sweeps, a failed one not keeping the next from its turn", () =>
    atToday(
      Effect.gen(function* () {
        const outcomes = yield* Queue.unbounded<string>();
        const say = (said: string) => Queue.offer(outcomes, said).pipe(Effect.asVoid);

        const fiber = yield* Effect.forkChild(
          daily([
            reported(Effect.fail("full disk"), {
              swept: () => say("first swept"),
              failed: () => say("first failed"),
            }),
            reported(Effect.succeed(2), {
              swept: (n) => say(`second removed ${n}`),
              failed: () => say("second failed"),
            }),
          ]),
        );

        expect([yield* Queue.take(outcomes), yield* Queue.take(outcomes)]).toEqual([
          "first failed",
          "second removed 2",
        ]);

        yield* TestClock.adjust("24 hours");

        expect([yield* Queue.take(outcomes), yield* Queue.take(outcomes)]).toEqual([
          "first failed",
          "second removed 2",
        ]);

        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});

describe("sweepRotatedLogs", () => {
  effect("removes a log's rotations older than 30 days, by name, and keeps the rest", () =>
    atToday(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* scratch;
        yield* setToday;

        for (const name of [
          "daemon.log",
          "daemon.out.log",
          "daemon.2026-09-01.log",
          "daemon.2026-09-30.log",
          "daemon.2026-10-01.log",
          "daemon.2026-10-30.log",
          "daemon.2020-13-45.log",
          "other.2020-01-01.log",
        ]) {
          yield* fs.writeFileString(`${dir}/${name}`, "x");
        }

        const removed = yield* sweepRotatedLogs(
          `${dir}/daemon.log`,
          DAEMON_LOG_RETENTION.maxAgeDays,
        );

        expect(removed).toEqual(["daemon.2026-09-01.log", "daemon.2026-09-30.log"]);
        expect(yield* entries(dir)).toEqual([
          "daemon.2020-13-45.log",
          "daemon.2026-10-01.log",
          "daemon.2026-10-30.log",
          "daemon.log",
          "daemon.out.log",
          "other.2020-01-01.log",
        ]);
      }),
    ),
  );
});

describe("capLog", () => {
  effect("empties a log past its cap, and leaves one under it alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      yield* fs.writeFileString(`${dir}/big.log`, "x".repeat(200));
      yield* fs.writeFileString(`${dir}/small.log`, "x".repeat(50));

      expect(yield* capLog(`${dir}/big.log`, 100)).toBe(true);
      expect(yield* capLog(`${dir}/small.log`, 100)).toBe(false);
      expect(yield* capLog(`${dir}/missing.log`, 100)).toBe(false);

      expect(yield* fs.readFileString(`${dir}/big.log`)).toBe("");
      expect(yield* fs.readFileString(`${dir}/small.log`)).toBe("x".repeat(50));
      // daemon.out.log's cap.
      expect(DAEMON_LOG_RETENTION.outLogMaxBytes).toBe(10 * 1024 * 1024);
    }),
  );
});
