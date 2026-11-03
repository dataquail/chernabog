// A run's steps as lanes, columns and the arrows between them.

import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { MAIN, runGraph, splitStep, type StepRecord, took } from "./run-graph.ts";

const at = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 9, 31, 14, 0, seconds)));

const entered = (step: string, seconds: number): StepRecord => ({
  step,
  enteredAt: at(seconds),
  finishedAt: Option.none(),
  outcome: Option.none(),
});

const recorded = (
  step: string,
  seconds: number,
  ended: number,
  outcome: "ok" | "failed",
): StepRecord => ({
  step,
  enteredAt: at(seconds),
  finishedAt: Option.some(at(ended)),
  outcome: Option.some(outcome),
});

const running = { running: true, finishedAt: Option.none() };
const finished = (seconds: number) => ({ running: false, finishedAt: Option.some(at(seconds)) });

// An epic's steps as the daemon kept them before it recorded ends: the run's
// line, then three tasks at once.
const epic = [
  entered("claim-epic", 0),
  entered("epic-tasks-1", 1),
  entered("claim#task-284", 2),
  entered("claim#task-281", 2),
  entered("claim#task-282", 3),
  entered("implement#task-282", 4),
  entered("implement#task-281", 4),
  entered("implement#task-284", 5),
  entered("push#task-284", 20),
  entered("claim#task-283", 30),
  entered("implement#task-283", 31),
];

describe("a step's name", () => {
  test("puts a step with an id in that lane, and one without on the run's line", () => {
    expect(splitStep("implement#task-284")).toEqual({ label: "implement", lane: "task-284" });
    expect(splitStep("ci-1-2#task-12-2")).toEqual({ label: "ci-1-2", lane: "task-12-2" });
    expect(splitStep("claim-epic")).toEqual({ label: "claim-epic", lane: MAIN });
  });
});

describe("a run's graph", () => {
  test("of a run on one line is one lane, its steps in order, each ending as the next starts", () => {
    const graph = runGraph(
      [entered("implement", 10), entered("claim", 0), entered("push", 30)],
      [],
      finished(40),
    );

    expect(graph.parallel).toBe(false);
    expect(graph.edges).toEqual([]);
    expect(graph.lanes.map((lane) => lane.label)).toEqual(["run"]);

    const steps = graph.lanes[0]?.steps ?? [];

    expect(steps.map((step) => step.label)).toEqual(["claim", "implement", "push"]);
    // Nothing kept when the last step ended, and the run's end isn't it.
    expect(steps.map((step) => step.endedAt)).toEqual([
      Option.some(Date.parse(at(10))),
      Option.some(Date.parse(at(30))),
      Option.none(),
    ]);
    expect(steps.every((step) => step.state === "ended")).toBe(true);
    expect(steps.map((step) => took(step.startedAt, step.endedAt, step.state, 0))).toEqual([
      Option.some(10_000),
      Option.some(20_000),
      Option.none(),
    ]);
  });

  test("takes a step a resumed run entered again as the one step, from its first entry", () => {
    const graph = runGraph(
      [
        entered("claim", 0),
        entered("implement", 10),
        entered("implement", 80),
        entered("implement", 150),
        entered("push", 200),
      ],
      [],
      running,
    );

    const steps = graph.lanes[0]?.steps ?? [];

    expect(steps.map((step) => step.label)).toEqual(["claim", "implement", "push"]);
    expect(steps[1]?.startedAt).toBe(Date.parse(at(10)));
    expect(Option.getOrNull(steps[1]?.endedAt ?? Option.none())).toBe(Date.parse(at(200)));
  });

  test("counts a running step up to now", () => {
    const started = Date.parse(at(0));

    expect(took(started, Option.none(), "running", Date.parse(at(5)))).toEqual(Option.some(5_000));
  });

  test("gives each task its own lane, hung off the run's line when it waited on nothing", () => {
    const graph = runGraph(epic, [], running);

    expect(graph.parallel).toBe(true);
    expect(graph.columns.map((column) => column.map((lane) => lane.id))).toEqual([
      [MAIN],
      ["task-284", "task-281", "task-282", "task-283"],
    ]);
    expect(graph.edges).toEqual([
      { from: MAIN, to: "task-284" },
      { from: MAIN, to: "task-281" },
      { from: MAIN, to: "task-282" },
      { from: MAIN, to: "task-283" },
    ]);
  });

  test("puts a task after the tasks it waited on, with an arrow from each", () => {
    const graph = runGraph(
      epic,
      [
        { lane: "task-283", needs: ["task-282", "task-281"] },
        // A lane the run has no steps in yet draws nothing.
        { lane: "task-285", needs: ["task-284"] },
        { lane: "task-283", needs: ["task-404"] },
      ],
      running,
    );

    expect(graph.columns.map((column) => column.map((lane) => lane.id))).toEqual([
      [MAIN],
      ["task-284", "task-281", "task-282"],
      ["task-283"],
    ]);
    expect(graph.edges.filter((edge) => edge.to === "task-283")).toEqual([
      { from: "task-282", to: "task-283" },
      { from: "task-281", to: "task-283" },
    ]);
  });

  test("survives a cycle a flow should never have declared", () => {
    const graph = runGraph(
      [entered("a#x", 0), entered("b#y", 1)],
      [
        { lane: "x", needs: ["y"] },
        { lane: "y", needs: ["x"] },
      ],
      running,
    );

    expect(graph.lanes.map((lane) => lane.id).sort()).toEqual(["x", "y"]);
  });

  test("leaves a lane's last step running while the run is, and ends it with the run after", () => {
    const live = runGraph(epic, [], running);
    const lane = live.lanes.find((each) => each.id === "task-284");

    expect(lane?.steps.map((step) => step.state)).toEqual(["ended", "ended", "running"]);
    expect(lane?.state).toBe("running");
    expect(Option.isNone(lane?.endedAt ?? Option.some(0))).toBe(true);

    const done = runGraph(epic, [], finished(60));

    expect(done.lanes.find((each) => each.id === "task-284")?.state).toBe("ended");
  });

  test("takes the ends and outcomes the daemon recorded over what it would infer", () => {
    const graph = runGraph(
      [
        recorded("claim", 0, 2, "ok"),
        recorded("implement", 3, 9, "failed"),
        entered("hand-off", 10),
      ],
      [],
      finished(12),
    );

    const steps = graph.lanes[0]?.steps ?? [];

    expect(steps.map((step) => step.state)).toEqual(["ok", "failed", "ended"]);
    expect(Option.getOrNull(steps[0]?.endedAt ?? Option.none())).toBe(Date.parse(at(2)));
    expect(graph.lanes[0]?.state).toBe("failed");
  });

  test("calls a lane ok only once every step in it is", () => {
    const graph = runGraph(
      [
        recorded("a#t", 0, 1, "ok"),
        recorded("b#t", 2, 3, "ok"),
        recorded("a#u", 0, 1, "ok"),
        entered("b#u", 2),
      ],
      [],
      running,
    );

    expect(graph.lanes.map((lane) => [lane.id, lane.state])).toEqual([
      ["t", "ok"],
      ["u", "running"],
    ]);
  });
});
