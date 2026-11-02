import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunLogLines } from "./run-log-line.value-object.ts";

const T = "2026-11-02T10:00:00.000Z";

// A tagged log: the main line, two tasks interleaved, and an entry of two lines.
const tagged = [
  RunLogLines.entry(T, Option.none(), "claimed #12"),
  RunLogLines.entry(T, Option.some("implement#task-1"), "step: implement#task-1"),
  RunLogLines.entry(T, Option.some("implement#task-2"), "step: implement#task-2"),
  RunLogLines.entry(T, Option.some("implement#task-1"), "Bash(bun test)"),
  RunLogLines.entry(T, Option.some("implement#task-2"), "Bash(git status)"),
  RunLogLines.entry(T, Option.some("implement#task-1"), "failed:\n  at line 3"),
  RunLogLines.entry(T, Option.none(), "finished: done: ok"),
]
  .map((line) => `${line}\n`)
  .join("");

// A log from before tags.
const old = [
  `${T} claimed #12`,
  `${T} step: claim`,
  `${T} took the claim`,
  `${T} step: implement`,
  `${T} Bash(bun test)`,
  `${T} finished: done: ok`,
]
  .map((line) => `${line}\n`)
  .join("");

describe("run log lines", () => {
  test("a person reads a tagged line as an untagged one, and an old line as it was", () => {
    expect(RunLogLines.untagged(tagged).split("\n").slice(0, 4)).toEqual([
      `${T} claimed #12`,
      `${T} step: implement#task-1`,
      `${T} step: implement#task-2`,
      `${T} Bash(bun test)`,
    ]);
    expect(RunLogLines.untagged(old)).toBe(old);
  });

  test("a step's tag is one line with no tabs", () => {
    expect(RunLogLines.entry(T, Option.some("odd\tname\n"), "x")).toBe(`${T}\todd name \tx`);
  });

  test("a log splits by its tags, by its step lines when it has none and no lanes, else not", () => {
    expect(RunLogLines.stepLogsOf(Option.some(tagged), true)).toBe("tagged");
    expect(RunLogLines.stepLogsOf(Option.some(old), false)).toBe("inferred");
    expect(RunLogLines.stepLogsOf(Option.some(old), true)).toBe("unavailable");
    expect(RunLogLines.stepLogsOf(Option.some(""), true)).toBe("tagged");
    expect(RunLogLines.stepLogsOf(Option.none(), false)).toBe("tagged");
  });

  test("a step's lines are those tagged with it, an entry's later lines with it", () => {
    expect(RunLogLines.linesOfStep(tagged, "implement#task-1", "tagged", 0)).toEqual({
      text: Option.some(
        [`${T} step: implement#task-1`, `${T} Bash(bun test)`, `${T} failed:`, "  at line 3"].join(
          "\n",
        ),
      ),
      next: tagged.length,
    });
  });

  test("read from an offset, a step's lines are those after it, and only whole ones", () => {
    const from = tagged.indexOf("Bash(git status)");
    const lineStart = tagged.lastIndexOf("\n", from) + 1;
    const partial = `${tagged}${T}\timplement#task-2\tBash(`;

    expect(RunLogLines.linesOfStep(partial, "implement#task-2", "tagged", lineStart)).toEqual({
      text: Option.some(`${T} Bash(git status)`),
      next: tagged.length,
    });
    expect(RunLogLines.linesOfStep(tagged, "implement#task-2", "tagged", tagged.length)).toEqual({
      text: Option.none(),
      next: tagged.length,
    });
  });

  test("an old log's step has the lines from its step line to the next", () => {
    expect(RunLogLines.linesOfStep(old, "claim", "inferred", 0).text).toEqual(
      Option.some(`${T} step: claim\n${T} took the claim`),
    );
    expect(RunLogLines.linesOfStep(old, "implement", "inferred", 0).text).toEqual(
      Option.some(`${T} step: implement\n${T} Bash(bun test)\n${T} finished: done: ok`),
    );
  });

  test("an old log of a run with lanes splits into nothing", () => {
    expect(RunLogLines.linesOfStep(old, "claim", "unavailable", 0)).toEqual({
      text: Option.none(),
      next: old.length,
    });
  });
});
