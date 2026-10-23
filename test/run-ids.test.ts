// A run's id is random; a prefix of it names the run, and a label says what it is.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { Home, homePaths } from "../src/config.ts";
import { resolveRunId } from "../src/engine.ts";
import { runLabel, shortRunId } from "../src/kernel/run-id.id.ts";
import { effectAtHome } from "./effect-test.ts";

const FIRST = "3f2a9c1e-7b4d-4e8a-9c2f-1d5e6a7b8c9d";
const SECOND = "3f2b0000-0000-4000-8000-000000000000";
const OLD = "demo.implement.issue-7.20261021-120000";

const withLogs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = homePaths((yield* Home).root).runs;
  yield* fs.makeDirectory(dir, { recursive: true });

  for (const id of [FIRST, SECOND, OLD]) {
    yield* fs.writeFileString(`${dir}/${id}.log`, "");
  }
});

const resolved = (prefix: string) => Effect.result(resolveRunId(prefix));

describe("run ids", () => {
  effectAtHome("a prefix that names one run is enough", () =>
    Effect.gen(function* () {
      yield* withLogs;
      expect(yield* resolved("3f2a")).toEqual(Result.succeed(FIRST));
      expect(yield* resolved(FIRST)).toEqual(Result.succeed(FIRST));
      expect(yield* resolved("demo.implement")).toEqual(Result.succeed(OLD));
    }),
  );

  effectAtHome("a prefix that names several runs, or none, is refused", () =>
    Effect.gen(function* () {
      yield* withLogs;
      const several = yield* resolved("3f2");
      expect(Result.isFailure(several) && several.failure.message).toBe(
        `3f2 names 2 runs (${FIRST}, ${SECOND}); give more of the id`,
      );
      const none = yield* resolved("ffff");
      expect(Result.isFailure(none) && none.failure.message).toBe("no run ffff");
    }),
  );

  test("a random id shows as its first eight characters; an old readable one, whole", () => {
    expect(shortRunId(FIRST)).toBe("3f2a9c1e");
    expect(shortRunId(OLD)).toBe(OLD);
  });

  test("a label says what a run is, and as whom", () => {
    expect(
      runLabel({ repo: "demo", flow: "review", itemKey: "pr-12", persona: Option.some("bob") }),
    ).toBe("demo/review pr-12 as bob");
    expect(
      runLabel({ repo: "demo", flow: "review", itemKey: "pr-12", persona: Option.none() }),
    ).toBe("demo/review pr-12");
  });
});
