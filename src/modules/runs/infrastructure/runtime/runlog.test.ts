import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { RunLogLimit, runLogWriting } from "./runlog.ts";

const scratchLog = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-runlog-" }),
).pipe(Effect.map((dir) => `${dir}/runs/run-1.log`));

const linesOf = (path: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line.length > 0)),
  );

// A run writing 100 lines of about 100 bytes each through two writers, as
// a run's workflow and the hub's notes each write its log.
const flood = (path: string) =>
  Effect.gen(function* () {
    const first = yield* runLogWriting(path);
    const second = yield* runLogWriting(path);

    for (let at = 0; at < 50; at++) {
      yield* first.log(`first ${at} ${"x".repeat(80)}`);
      yield* second.log(`second ${at} ${"y".repeat(80)}`);
    }
  });

describe("a run's log", () => {
  effect("with no limit, keeps every line", () =>
    Effect.gen(function* () {
      const path = yield* scratchLog;

      yield* flood(path);

      expect(yield* linesOf(path)).toHaveLength(100);
    }),
  );

  effect("limited, stops at its bound with one line saying so, whichever writer writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* scratchLog;

      yield* flood(path).pipe(Effect.provideService(RunLogLimit, Option.some(2_000)));

      const lines = yield* linesOf(path);
      const stopped = lines.filter((line) => line.includes("this run's log stopped"));

      expect(stopped).toHaveLength(1);
      expect(lines.at(-1)).toContain("this run's log stopped at its bound of 2 kB");
      expect(lines.length).toBeLessThan(100);

      // What came before the stop line fits within the bound.
      const before = Buffer.byteLength(`${lines.slice(0, -1).join("\n")}\n`);
      expect(before).toBeLessThanOrEqual(2_000);
      // The stop line takes the log past the bound, so the hub sees it there,
      // and by no more than itself.
      expect(Number((yield* fs.stat(path)).size)).toBeGreaterThan(2_000);
      expect(Number((yield* fs.stat(path)).size)).toBeLessThan(2_000 + 200);
    }),
  );

  effect(
    "limited, writes one stop line though the entry it drops is many times the room left",
    () =>
      Effect.gen(function* () {
        const path = yield* scratchLog;

        yield* Effect.gen(function* () {
          const log = yield* runLogWriting(path);
          yield* log.log("a");
          yield* log.log("x".repeat(5_000));

          for (const line of ["b", "c", "d"]) {
            yield* log.log(line);
          }
        }).pipe(Effect.provideService(RunLogLimit, Option.some(2_000)));

        const lines = yield* linesOf(path);

        expect(lines.filter((line) => line.includes("this run's log stopped"))).toHaveLength(1);
        expect(lines.some((line) => line.endsWith("\td"))).toBe(false);
      }),
  );
});
