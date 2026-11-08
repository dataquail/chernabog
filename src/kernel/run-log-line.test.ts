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

  describe("tagged with the plan node they were written in", () => {
    const node = '{"id":"agent","round":2,"lane":"task-1"}';

    // A run of a flow with a plan: the main line outside any node, a task's
    // steps in theirs, and a line written in a node but no step.
    const withNodes = [
      RunLogLines.entry(T, Option.none(), "claimed #12"),
      RunLogLines.entry(
        T,
        Option.some("implement#task-1"),
        "step: implement#task-1",
        Option.some(node),
      ),
      RunLogLines.entry(T, Option.some("implement#task-1"), "a\tb", Option.some(node)),
      RunLogLines.entry(T, Option.none(), "between steps", Option.some('{"id":"ready"}')),
    ]
      .map((line) => `${line}\n`)
      .join("");

    test("a line carries its node after its step, and a person reads it without either", () => {
      expect(withNodes.split("\n")[1]).toBe(
        `${T}\timplement#task-1\t@${node}\tstep: implement#task-1`,
      );
      expect(RunLogLines.untagged(withNodes).split("\n").slice(0, 4)).toEqual([
        `${T} claimed #12`,
        `${T} step: implement#task-1`,
        `${T} a\tb`,
        `${T} between steps`,
      ]);
    });

    test("a line's node is its tag's; none for a line with no node, and for an old line", () => {
      expect(withNodes.split("\n").slice(0, 4).map(RunLogLines.nodeOf)).toEqual([
        Option.none(),
        Option.some(node),
        Option.some(node),
        Option.some('{"id":"ready"}'),
      ]);
      expect(RunLogLines.nodeOf(`${T}\timplement\tstep: implement`)).toEqual(Option.none());
      expect(RunLogLines.nodeOf(`${T} step: implement`)).toEqual(Option.none());
    });

    test("a step's lines are found by its tag, whatever node they carry", () => {
      expect(RunLogLines.linesOfStep(withNodes, "implement#task-1", "tagged", 0).text).toEqual(
        Option.some(`${T} step: implement#task-1\n${T} a\tb`),
      );
      expect(RunLogLines.stepLogsOf(Option.some(withNodes), true)).toBe("tagged");
    });

    // One step name run at a node in two rounds, and in another lane: a node's
    // page asks for the step's lines at its own node alone.
    const rounds = [
      RunLogLines.entry(T, Option.some("ci"), "step: ci", Option.some('{"id":"ci","round":1}')),
      RunLogLines.entry(
        T,
        Option.some("ci"),
        "red\n  in round 1",
        Option.some('{"id":"ci","round":1}'),
      ),
      RunLogLines.entry(T, Option.some("ci"), "step: ci", Option.some('{"id":"ci","round":2}')),
      RunLogLines.entry(T, Option.some("ci"), "green", Option.some('{"round":2,"id":"ci"}')),
      RunLogLines.entry(
        T,
        Option.some("ci"),
        "other lane",
        Option.some('{"id":"ci","round":2,"lane":"task-1"}'),
      ),
      RunLogLines.entry(T, Option.some("ci"), "no node"),
    ]
      .map((line) => `${line}\n`)
      .join("");

    test("a step's lines at one node are those its tags put in that node's round and lane", () => {
      const at = (wanted: {
        readonly id: string;
        readonly round?: number;
        readonly lane?: string;
      }) => RunLogLines.linesOfStep(rounds, "ci", "tagged", 0, Option.some(wanted)).text;

      expect(at({ id: "ci", round: 1 })).toEqual(
        Option.some(`${T} step: ci\n${T} red\n  in round 1`),
      );
      expect(at({ id: "ci", round: 2 })).toEqual(Option.some(`${T} step: ci\n${T} green`));
      expect(at({ id: "ci", round: 2, lane: "task-1" })).toEqual(Option.some(`${T} other lane`));
      expect(at({ id: "ci", round: 3 })).toEqual(Option.none());
      expect(RunLogLines.linesOfStep(rounds, "ci", "tagged", 0).text).toEqual(
        Option.some(
          [
            `${T} step: ci`,
            `${T} red`,
            "  in round 1",
            `${T} step: ci`,
            `${T} green`,
            `${T} other lane`,
            `${T} no node`,
          ].join("\n"),
        ),
      );
    });
  });
});
