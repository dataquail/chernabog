// A run's history put on its plan: each node's state, start, end and engine
// steps, as the dashboard's canvas and the TUI both draw it.

import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type PlanNode } from "../plan/flow-plan.value-object.ts";
import { NodeRef } from "../plan/node-ref.value-object.ts";
import {
  RunBranch,
  RunEnd,
  RunHistory,
  RunLane,
  RunNodeVisit,
  RunStep,
} from "../run/run-history.value-object.ts";
import { type RunStatus } from "../run/run-status.value-object.ts";
import { RunWait } from "../run-wait/run-wait-view.value-object.ts";
import { type NodeOnPlan, RunOnPlan } from "./run-on-plan.domain-service.ts";

const at = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 14, 0, seconds)));

type Where = { readonly round?: number; readonly lane?: string };

const ref = (id: string, where: Where = {}) => NodeRef.make({ id, ...where });

// --- The plan, as a flow document compiles it ---------------------------

const use = (
  id: string,
  branches: ReadonlyArray<{
    readonly outcome: string;
    readonly steps: ReadonlyArray<PlanNode>;
  }> = [],
): PlanNode => ({ id, path: id, kind: "use", block: `demo.${id}`, in: {}, with: {}, branches });

const end = (path: string): PlanNode => ({ id: path, path, kind: "end", end: "done" });

const next = (path: string): PlanNode => ({ id: path, path, kind: "next", next: {} });

const repeat = (id: string, steps: ReadonlyArray<PlanNode>): PlanNode => ({
  id,
  path: id,
  kind: "repeat",
  state: {},
  steps,
});

const forEach = (id: string, steps: ReadonlyArray<PlanNode>): PlanNode => ({
  id,
  path: id,
  kind: "forEach",
  forEach: "tasks.tasks",
  as: "task",
  scope: "epic.task",
  atOnce: "3",
  steps,
});

const when = (path: string, steps: ReadonlyArray<PlanNode>): PlanNode => ({
  id: path,
  path,
  kind: "if",
  condition: "claim.fresh",
  steps,
});

// --- A run's history, as the daemon serves it ---------------------------

type Visit = {
  readonly id: string;
  readonly from: number;
  readonly to?: number;
  readonly outcome?: "ok" | "failed";
} & Where;

const visit = ({ from, id, outcome, to, ...where }: Visit) =>
  RunNodeVisit.make({
    node: ref(id, where),
    enteredAt: at(from),
    ...Option.match(Option.fromUndefinedOr(to), {
      onNone: () => ({}),
      onSome: (seconds) => ({ finishedAt: at(seconds) }),
    }),
    ...Option.match(Option.fromUndefinedOr(outcome), {
      onNone: () => ({}),
      onSome: (how) => ({ outcome: how }),
    }),
  });

type Step = {
  readonly step: string;
  readonly from: number;
  readonly to?: number;
  readonly outcome?: "ok" | "failed";
  readonly node?: NodeRef;
};

const step = ({ from, node, outcome, step: name, to }: Step) =>
  RunStep.make({
    step: name,
    enteredAt: at(from),
    ...Option.match(Option.fromUndefinedOr(node), {
      onNone: () => ({}),
      onSome: (found) => ({ node: found }),
    }),
    ...Option.match(Option.fromUndefinedOr(to), {
      onNone: () => ({}),
      onSome: (seconds) => ({ finishedAt: at(seconds) }),
    }),
    ...Option.match(Option.fromUndefinedOr(outcome), {
      onNone: () => ({}),
      onSome: (how) => ({ outcome: how }),
    }),
  });

const took = (id: string, outcome: string, seconds: number, where: Where = {}) =>
  RunBranch.make({ node: ref(id, where), outcome, takenAt: at(seconds) });

const reached = (path: string, seconds: number, where: Where = {}) =>
  RunEnd.make({ node: ref(path, where), reachedAt: at(seconds) });

const parked = (seconds: number) =>
  Schema.decodeSync(RunWait)({
    runId: "run-1",
    signal: "pr-push",
    deferred: "await-push",
    token: "token",
    parkedAt: at(seconds),
  });

const history = (fields: {
  readonly steps?: ReadonlyArray<RunStep>;
  readonly nodes?: ReadonlyArray<RunNodeVisit>;
  readonly branches?: ReadonlyArray<RunBranch>;
  readonly ends?: ReadonlyArray<RunEnd>;
  readonly waits?: ReadonlyArray<RunWait>;
  readonly lanes?: ReadonlyArray<{ readonly lane: string; readonly needs: ReadonlyArray<string> }>;
}) =>
  RunHistory.make({
    steps: fields.steps ?? [],
    waits: fields.waits ?? [],
    lanes: (fields.lanes ?? []).map((lane) => RunLane.make(lane)),
    plan: "hash",
    nodes: fields.nodes ?? [],
    branches: fields.branches ?? [],
    ends: fields.ends ?? [],
  });

const draw = (steps: ReadonlyArray<PlanNode>, found: RunHistory, status: RunStatus = "running") =>
  RunOnPlan.draw({ steps }, found, { status });

// A node's state, and its children's, as one line each, for a test to read.
const statesOf = (nodes: ReadonlyArray<NodeOnPlan>): ReadonlyArray<string> =>
  nodes.flatMap((node) => [
    `${node.node.id} ${node.state}`,
    ...node.branches.flatMap((branch) =>
      statesOf(branch.steps).map((line) => `  ${branch.outcome}: ${line}`),
    ),
    ...statesOf(node.body).map((line) => `  ${line}`),
  ]);

const nodeOf = (nodes: ReadonlyArray<NodeOnPlan>, id: string): NodeOnPlan =>
  Option.getOrThrow(Option.fromUndefinedOr(nodes.find((node) => node.node.id === id)));

// --- Plans the tests draw on ---------------------------------------------

// A review: claim, look, and either merge or ask for changes.
const REVIEW = [
  use("claim"),
  use("review", [
    { outcome: "approve", steps: [use("merge"), end("review.approve.end")] },
    { outcome: "changes", steps: [use("comment")] },
  ]),
  use("report"),
];

// An implementation that goes round until CI passes.
const LOOP = [
  use("claim"),
  repeat("rounds", [
    use("implement"),
    use("ci", [
      { outcome: "pass", steps: [end("rounds.ci.pass.end")] },
      { outcome: "fail", steps: [use("fix"), next("rounds.ci.fail.next")] },
    ]),
  ]),
];

// An epic: plan its tasks, then implement each in its lane.
const EPIC = [use("plan"), forEach("tasks", [use("implement"), use("ci")]), use("close")];

describe("each node's state", () => {
  test("a node the run finished is ok or failed, one it's in is running, one it hasn't got to not-reached", () => {
    const drawn = draw(
      REVIEW,
      history({
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "review", from: 3 }),
        ],
      }),
    );

    expect(statesOf(drawn.steps)).toEqual([
      "claim ok",
      "review running",
      "  approve: merge not-reached",
      "  approve: review.approve.end not-reached",
      "  changes: comment not-reached",
      "report not-reached",
    ]);
  });

  test("a node the run is parked in, on a signal, is waiting", () => {
    const drawn = draw(
      REVIEW,
      history({
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "review", from: 3 }),
        ],
        waits: [parked(4)],
      }),
    );

    expect(nodeOf(drawn.steps, "review").state).toBe("waiting");
    expect(nodeOf(drawn.steps, "claim").state).toBe("ok");
    expect(nodeOf(drawn.steps, "report").state).toBe("not-reached");
  });

  test("a step the run's condition skipped, when the run went on past it, is not-taken", () => {
    const drawn = draw(
      [use("claim"), when("steps[1]", [use("label")]), use("report")],
      history({
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "report", from: 3 }),
        ],
      }),
    );

    expect(statesOf(drawn.steps)).toEqual([
      "claim ok",
      "steps[1] not-taken",
      "  label not-taken",
      "report running",
    ]);
  });

  test("a step whose condition held is drawn in its if", () => {
    const drawn = draw(
      [use("claim"), when("steps[1]", [use("label")]), use("report")],
      history({
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "label", from: 3, to: 4, outcome: "ok" }),
          visit({ id: "report", from: 5 }),
        ],
      }),
    );

    expect(statesOf(drawn.steps)).toEqual([
      "claim ok",
      "steps[1] ok",
      "  label ok",
      "report running",
    ]);
    expect(nodeOf(drawn.steps, "steps[1]").startedAt).toEqual(Option.some(at(3)));
    expect(nodeOf(drawn.steps, "steps[1]").endedAt).toEqual(Option.some(at(4)));
  });
});

describe("a branch", () => {
  test("a run that approved took the approve branch, and not the other", () => {
    const drawn = draw(
      REVIEW,
      history({
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "review", from: 3, to: 4, outcome: "ok" }),
          visit({ id: "merge", from: 5, to: 6, outcome: "ok" }),
        ],
        branches: [took("review", "approve", 4)],
        ends: [reached("review.approve.end", 7)],
      }),
      "done",
    );

    expect(statesOf(drawn.steps)).toEqual([
      "claim ok",
      "review ok",
      "  approve: merge ok",
      "  approve: review.approve.end ok",
      "  changes: comment not-taken",
      "report not-reached",
    ]);
    expect(nodeOf(drawn.steps, "review").branches.map((branch) => branch.taken)).toEqual([
      true,
      false,
    ]);
  });

  test("a run that asked for changes took the changes branch, and not the other", () => {
    const drawn = draw(
      REVIEW,
      history({
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "review", from: 3, to: 4, outcome: "ok" }),
          visit({ id: "comment", from: 5, to: 6, outcome: "ok" }),
          visit({ id: "report", from: 7, to: 8, outcome: "ok" }),
        ],
        branches: [took("review", "changes", 4)],
      }),
      "done",
    );

    expect(statesOf(drawn.steps)).toEqual([
      "claim ok",
      "review ok",
      "  approve: merge not-taken",
      "  approve: review.approve.end not-taken",
      "  changes: comment ok",
      "report ok",
    ]);
  });
});

describe("a repeat", () => {
  // Two rounds CI failed, and the third is implementing.
  const third = history({
    nodes: [
      visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
      ...[1, 2].flatMap((round) => [
        visit({ id: "implement", round, from: round * 10, to: round * 10 + 1, outcome: "ok" }),
        visit({ id: "ci", round, from: round * 10 + 2, to: round * 10 + 3, outcome: "ok" }),
        visit({ id: "fix", round, from: round * 10 + 4, to: round * 10 + 5, outcome: "ok" }),
      ]),
      visit({ id: "implement", round: 3, from: 30 }),
    ],
    branches: [took("ci", "fail", 13, { round: 1 }), took("ci", "fail", 23, { round: 2 })],
    steps: [
      step({ step: "implement-3", from: 30, node: ref("implement", { round: 3 }) }),
      step({
        step: "implement-2",
        from: 20,
        to: 21,
        outcome: "ok",
        node: ref("implement", { round: 2 }),
      }),
    ],
  });

  test("in its third round gives each round with its body's states, the latest drawn", () => {
    const drawn = draw(LOOP, third);
    const rounds = nodeOf(drawn.steps, "rounds");

    expect(rounds.state).toBe("running");
    expect(rounds.rounds.map((round) => [round.round, round.state])).toEqual([
      [1, "ok"],
      [2, "ok"],
      [3, "running"],
    ]);
    expect(statesOf(rounds.rounds[0]?.steps ?? [])).toEqual([
      "implement ok",
      "ci ok",
      "  pass: rounds.ci.pass.end not-taken",
      "  fail: fix ok",
      "  fail: rounds.ci.fail.next ok",
    ]);
    expect(statesOf(rounds.body)).toEqual([
      "implement running",
      "ci not-reached",
      "  pass: rounds.ci.pass.end not-reached",
      "  fail: fix not-reached",
      "  fail: rounds.ci.fail.next not-reached",
    ]);
    expect(rounds.startedAt).toEqual(Option.some(at(10)));
    expect(rounds.endedAt).toEqual(Option.none());
  });

  test("puts each round's engine steps on its own node", () => {
    const rounds = nodeOf(draw(LOOP, third).steps, "rounds");

    expect(
      rounds.rounds.map((round) => nodeOf(round.steps, "implement").steps.map((s) => s.step)),
    ).toEqual([[], ["implement-2"], ["implement-3"]]);
    expect(nodeOf(rounds.body, "implement").startedAt).toEqual(Option.some(at(30)));
  });

  test("not yet reached has its body not-reached, and no rounds", () => {
    const drawn = draw(LOOP, history({ nodes: [visit({ id: "claim", from: 1 })] }));
    const rounds = nodeOf(drawn.steps, "rounds");

    expect(rounds.state).toBe("not-reached");
    expect(rounds.rounds).toEqual([]);
    expect(statesOf(rounds.body)[0]).toBe("implement not-reached");
  });
});

describe("a forEach", () => {
  // task-2 and task-3 waited on task-1; task-1 is done, task-2 in CI, and
  // task-3 hasn't started its body.
  const epic = history({
    nodes: [
      visit({ id: "plan", from: 1, to: 2, outcome: "ok" }),
      visit({ id: "tasks", from: 3 }),
      visit({ id: "implement", lane: "task-1", from: 4, to: 5, outcome: "ok" }),
      visit({ id: "ci", lane: "task-1", from: 6, to: 7, outcome: "ok" }),
      visit({ id: "implement", lane: "task-2", from: 8, to: 9, outcome: "ok" }),
      visit({ id: "ci", lane: "task-2", from: 10 }),
    ],
    steps: [
      step({ step: "claim#task-3", from: 8, node: ref("tasks", { lane: "task-3" }) }),
      step({
        step: "implement#task-2",
        from: 8,
        to: 9,
        outcome: "ok",
        node: ref("implement", { lane: "task-2" }),
      }),
    ],
    lanes: [
      { lane: "task-2", needs: ["task-1"] },
      { lane: "task-3", needs: ["task-1"] },
    ],
  });

  test("gives its lanes, each with its body's states, laid out by what each waited on", () => {
    const tasks = nodeOf(draw(EPIC, epic).steps, "tasks");

    expect(tasks.state).toBe("running");
    expect(
      tasks.lanes.map((lane) => ({
        lane: lane.lane,
        needs: lane.needs,
        column: lane.column,
        state: lane.state,
        body: statesOf(lane.body),
      })),
    ).toEqual([
      { lane: "task-1", needs: [], column: 1, state: "ok", body: ["implement ok", "ci ok"] },
      {
        lane: "task-2",
        needs: ["task-1"],
        column: 2,
        state: "running",
        body: ["implement ok", "ci running"],
      },
      {
        lane: "task-3",
        needs: ["task-1"],
        column: 2,
        state: "running",
        body: ["implement not-reached", "ci not-reached"],
      },
    ]);
    expect(tasks.edges).toEqual([
      { from: "tasks", to: "task-1" },
      { from: "task-1", to: "task-2" },
      { from: "task-1", to: "task-3" },
    ]);
    expect(tasks.columns).toEqual([["task-1"], ["task-2", "task-3"]]);
  });

  test("puts a lane's own engine steps on the lane, and a body's on its node in that lane", () => {
    const tasks = nodeOf(draw(EPIC, epic).steps, "tasks");
    const lane = (id: string) => tasks.lanes.find((found) => found.lane === id);

    expect(lane("task-3")?.steps.map((s) => s.step)).toEqual(["claim#task-3"]);
    expect(nodeOf(lane("task-2")?.body ?? [], "implement").steps.map((s) => s.step)).toEqual([
      "implement#task-2",
    ]);
    expect(nodeOf(lane("task-1")?.body ?? [], "implement").steps).toEqual([]);
    expect(nodeOf(draw(EPIC, epic).steps, "close").state).toBe("not-reached");
  });

  test("not yet reached draws its body not-reached, with no lanes", () => {
    const tasks = nodeOf(
      draw(EPIC, history({ nodes: [visit({ id: "plan", from: 1 })] })).steps,
      "tasks",
    );

    expect(tasks.state).toBe("not-reached");
    expect(tasks.lanes).toEqual([]);
    expect(statesOf(tasks.body)).toEqual(["implement not-reached", "ci not-reached"]);
  });
});

describe("a run parked mid-plan", () => {
  test("waits in the node it parked in, inside its round and lane", () => {
    const drawn = draw(
      [use("plan"), repeat("rounds", [forEach("tasks", [use("implement"), use("ci")])])],
      history({
        nodes: [
          visit({ id: "plan", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "tasks", round: 1, from: 3 }),
          visit({ id: "implement", round: 1, lane: "task-1", from: 4, to: 5, outcome: "ok" }),
          visit({ id: "ci", round: 1, lane: "task-1", from: 6 }),
        ],
        waits: [parked(7)],
      }),
    );

    const rounds = nodeOf(drawn.steps, "rounds");
    const tasks = nodeOf(rounds.body, "tasks");

    expect(rounds.state).toBe("waiting");
    expect(tasks.state).toBe("waiting");
    expect(tasks.lanes.map((lane) => [lane.lane, lane.state, statesOf(lane.body)])).toEqual([
      ["task-1", "waiting", ["implement ok", "ci waiting"]],
    ]);
  });
});

describe("a run that failed mid-plan", () => {
  const failed = history({
    steps: [
      step({ step: "read-trigger", from: 0, to: 1, outcome: "ok" }),
      step({
        step: "merge",
        from: 5,
        to: 6,
        outcome: "failed",
        node: ref("merge"),
      }),
      step({ step: "tell-person", from: 7, to: 8, outcome: "ok" }),
      step({ step: "release-claim", from: 9, to: 10, outcome: "ok" }),
    ],
    nodes: [
      visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
      visit({ id: "review", from: 3, to: 4, outcome: "ok" }),
      visit({ id: "merge", from: 5, to: 6, outcome: "failed" }),
    ],
    branches: [took("review", "approve", 4)],
  });

  test("marks the node it left the plan at, and every node after it not-reached", () => {
    const drawn = draw(REVIEW, failed, "failed");

    expect(statesOf(drawn.steps)).toEqual([
      "claim ok",
      "review ok",
      "  approve: merge failed",
      "  approve: review.approve.end not-reached",
      "  changes: comment not-taken",
      "report not-reached",
    ]);
    expect(drawn.left).toEqual(Option.some(ref("merge")));

    const merge = nodeOf(nodeOf(drawn.steps, "review").branches[0]?.steps ?? [], "merge");

    expect(merge.left).toBe(true);
    expect(nodeOf(drawn.steps, "claim").left).toBe(false);
  });

  test("a run that ended with no node failing left nowhere", () => {
    expect(draw(REVIEW, failed, "done").left).toEqual(Option.none());
  });
});

describe("engine steps that belong to no node", () => {
  test("go to set up before the plan, or to wrap up after it, by when they ran", () => {
    const drawn = draw(
      REVIEW,
      history({
        steps: [
          step({ step: "read-trigger", from: 0, to: 1, outcome: "ok" }),
          step({ step: "claim", from: 1, to: 2, outcome: "ok", node: ref("claim") }),
          step({ step: "tell-person", from: 7, to: 8, outcome: "ok" }),
          step({ step: "release-claim", from: 9 }),
        ],
        nodes: [
          visit({ id: "claim", from: 1, to: 2, outcome: "ok" }),
          visit({ id: "review", from: 3, to: 4, outcome: "ok" }),
          visit({ id: "comment", from: 5, to: 6, outcome: "ok" }),
        ],
        branches: [took("review", "changes", 4)],
      }),
    );

    expect(drawn.setUp.steps.map((s) => s.step)).toEqual(["read-trigger"]);
    expect(drawn.setUp.state).toBe("ok");
    expect(drawn.setUp.startedAt).toEqual(Option.some(at(0)));
    expect(drawn.setUp.endedAt).toEqual(Option.some(at(1)));
    expect(drawn.wrapUp.steps.map((s) => s.step)).toEqual(["tell-person", "release-claim"]);
    expect(drawn.wrapUp.state).toBe("running");
    expect(nodeOf(drawn.steps, "claim").steps.map((s) => s.step)).toEqual(["claim"]);
  });

  test("a run still reading its trigger is in set up, its plan not reached", () => {
    const drawn = draw(REVIEW, history({ steps: [step({ step: "read-trigger", from: 0 })] }));

    expect(drawn.setUp.state).toBe("running");
    expect(drawn.wrapUp.state).toBe("not-reached");
    expect(drawn.wrapUp.steps).toEqual([]);
    expect(statesOf(drawn.steps)[0]).toBe("claim not-reached");
  });

  test("set up that failed fails, and the plan is never reached", () => {
    const drawn = draw(
      REVIEW,
      history({ steps: [step({ step: "read-trigger", from: 0, to: 1, outcome: "failed" })] }),
      "failed",
    );

    expect(drawn.setUp.state).toBe("failed");
    expect(drawn.wrapUp.state).toBe("not-reached");
    expect(statesOf(drawn.steps)).toContain("report not-reached");
  });

  test("a step a resumed run entered again is one step, from its first entry", () => {
    const drawn = draw(
      REVIEW,
      history({
        steps: [
          step({ step: "read-trigger", from: 0 }),
          step({ step: "read-trigger", from: 3, to: 4, outcome: "ok" }),
        ],
      }),
      "done",
    );

    expect(drawn.setUp.steps).toEqual([
      step({ step: "read-trigger", from: 0, to: 4, outcome: "ok" }),
    ]);
    expect(drawn.setUp.state).toBe("ok");
  });
});
