import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import { effect } from "../../test/effect-test.ts";
import { dailyLogWriting } from "./daily-log.ts";

const scratch = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-daily-log-" }),
);

const onTestClock = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  test.pipe(Effect.provide(TestClock.layer()));

const at = (iso: string) => TestClock.setTime(Date.parse(iso));

const read = (path: string) => FileSystem.FileSystem.use((fs) => fs.readFileString(path));

const entries = (dir: string) =>
  FileSystem.FileSystem.use((fs) => fs.readDirectory(dir)).pipe(
    Effect.map((names) => names.toSorted()),
  );

describe("dailyLogWriting", () => {
  effect("appends timestamped lines through the day", () =>
    onTestClock(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* at("2026-10-31T08:00:00Z");
        const { log } = yield* dailyLogWriting(`${dir}/daemon.log`);

        yield* log("one");
        yield* at("2026-10-31T23:59:00Z");
        yield* log("two");

        expect(yield* entries(dir)).toEqual(["daemon.log"]);
        expect(yield* read(`${dir}/daemon.log`)).toBe(
          "2026-10-31T08:00:00.000Z one\n2026-10-31T23:59:00.000Z two\n",
        );
      }),
    ),
  );

  effect("the first write of a new UTC day moves the day before's to daemon.<day>.log", () =>
    onTestClock(
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* at("2026-10-30T23:00:00Z");
        const { log } = yield* dailyLogWriting(`${dir}/daemon.log`);

        yield* log("one");
        yield* at("2026-10-31T01:00:00Z");
        yield* log("two");

        expect(yield* entries(dir)).toEqual(["daemon.2026-10-30.log", "daemon.log"]);
        expect(yield* read(`${dir}/daemon.2026-10-30.log`)).toBe("2026-10-30T23:00:00.000Z one\n");
        expect(yield* read(`${dir}/daemon.log`)).toBe("2026-10-31T01:00:00.000Z two\n");
      }),
    ),
  );

  effect("a log an earlier daemon left on an earlier day is moved to that day's", () =>
    onTestClock(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* scratch;
        yield* fs.writeFileString(`${dir}/daemon.log`, "left\n");
        yield* fs.utimes(
          `${dir}/daemon.log`,
          new Date("2026-10-29T12:00:00Z"),
          new Date("2026-10-29T12:00:00Z"),
        );
        yield* at("2026-10-31T09:00:00Z");
        const { log } = yield* dailyLogWriting(`${dir}/daemon.log`);

        yield* log("started");

        expect(yield* read(`${dir}/daemon.2026-10-29.log`)).toBe("left\n");
        expect(yield* read(`${dir}/daemon.log`)).toBe("2026-10-31T09:00:00.000Z started\n");
      }),
    ),
  );

  effect("a day's rotated log already there is added to, not replaced", () =>
    onTestClock(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* scratch;
        yield* fs.writeFileString(`${dir}/daemon.2026-10-30.log`, "earlier\n");
        yield* at("2026-10-30T22:00:00Z");
        const { log } = yield* dailyLogWriting(`${dir}/daemon.log`);

        yield* log("later");
        yield* at("2026-10-31T00:00:01Z");
        yield* log("next");

        expect(yield* read(`${dir}/daemon.2026-10-30.log`)).toBe(
          "earlier\n2026-10-30T22:00:00.000Z later\n",
        );
      }),
    ),
  );
});
