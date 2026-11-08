// A run row's strip: the run's path through its plan, from RunOnPlan, in the
// TUI's main view, shortened to fit the row and in place of the detail.

import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type DaemonStatus, RunOnPlan } from "../src/interface/daemon/daemon.protocol.ts";
import { initialModel } from "../src/interface/tui/app.ts";
import { runStrip } from "../src/interface/tui/strip.ts";
import { type Model, plain, view } from "../src/interface/tui/view.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { type PlanNode } from "../src/modules/runs/domain/plan/flow-plan.value-object.ts";
import { NodeRef } from "../src/modules/runs/domain/plan/node-ref.value-object.ts";
import {
  RunBranch,
  RunHistory,
  RunNodeVisit,
} from "../src/modules/runs/domain/run/run-history.value-object.ts";
import { type RunStatus } from "../src/modules/runs/domain/run/run-status.value-object.ts";
import { ActiveRun, RunView } from "../src/modules/runs/domain/run/run-view.value-object.ts";
import { RunWait } from "../src/modules/runs/domain/run-wait/run-wait-view.value-object.ts";

const now = DateTime.makeUnsafe("2026-11-08T12:00:00Z");

const at = (seconds: number) => DateTime.formatIso(DateTime.add(now, { seconds: seconds - 3600 }));

// --- Plans -----------------------------------------------------------------

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

// Claim, run the agent, gate it, and open a pull request; a gate that fails
// asks a person.
const IMPLEMENT = [
  use("claim"),
  use("agent"),
  use("gate", [{ outcome: "fail", steps: [use("ask"), end("gate.fail.end")] }]),
  use("pr"),
];

// Goes round implementing until CI passes.
const LOOP = [
  use("claim"),
  repeat("rounds", [
    use("implement"),
    use("ci", [
      { outcome: "pass", steps: [end("rounds.ci.pass.end")] },
      { outcome: "fail", steps: [use("fix"), next("rounds.ci.fail.next")] },
    ]),
  ]),
  use("report"),
];

// Plans its tasks, then implements each in its lane.
const EPIC = [use("plan"), forEach("tasks", [use("implement"), use("ci")]), use("close")];

// --- Histories -------------------------------------------------------------

type Where = { readonly round?: number; readonly lane?: string };

const visit = (
  id: string,
  from: number,
  done: { readonly to?: number; readonly outcome?: "ok" | "failed" } = {},
  where: Where = {},
) =>
  RunNodeVisit.make({
    node: NodeRef.make({ id, ...where }),
    enteredAt: at(from),
    ...Option.match(Option.fromUndefinedOr(done.to), {
      onNone: () => ({}),
      onSome: (seconds) => ({ finishedAt: at(seconds) }),
    }),
    ...Option.match(Option.fromUndefinedOr(done.outcome), {
      onNone: () => ({}),
      onSome: (outcome) => ({ outcome }),
    }),
  });

const ok = (id: string, from: number, where: Where = {}) =>
  visit(id, from, { to: from + 1, outcome: "ok" }, where);

const history = (fields: {
  readonly nodes: ReadonlyArray<RunNodeVisit>;
  readonly branches?: ReadonlyArray<RunBranch>;
  readonly waits?: ReadonlyArray<RunWait>;
}) =>
  RunHistory.make({
    steps: [],
    waits: fields.waits ?? [],
    plan: "hash",
    nodes: fields.nodes,
    branches: fields.branches ?? [],
    ends: [],
  });

const parkedOn = Schema.decodeSync(RunWait)({
  runId: "run-1",
  signal: "pr-push",
  deferred: "await-push",
  token: "token",
  parkedAt: at(30),
});

// The strip as text, at a width.
const stripOf = (
  steps: ReadonlyArray<PlanNode>,
  found: RunHistory,
  status: RunStatus,
  width = 80,
): string =>
  Option.match(runStrip(RunOnPlan.draw({ steps }, found, { status }), width), {
    onNone: () => "(no strip)",
    onSome: (line) => plain([line]),
  });

const AT_AGENT = history({ nodes: [ok("claim", 1), visit("agent", 3)] });

describe("a run's strip", () => {
  test("a running run: the nodes it took, the one it is in, and the ones ahead", () => {
    expect(stripOf(IMPLEMENT, AT_AGENT, "running")).toBe("claim ✓ → agent ● → gate · → pr ·");
  });

  test("a finished run: every node it took, as it left them", () => {
    const done = history({
      nodes: [ok("claim", 1), ok("agent", 3), ok("gate", 5), ok("pr", 7)],
    });

    expect(stripOf(IMPLEMENT, done, "done")).toBe("claim ✓ → agent ✓ → gate ✓ → pr ✓");

    // A run that took a branch goes down it, and goes no further than its end.
    const failed = history({
      nodes: [ok("claim", 1), ok("agent", 3), ok("gate", 5), ok("ask", 7)],
      branches: [
        RunBranch.make({ node: NodeRef.make({ id: "gate" }), outcome: "fail", takenAt: at(6) }),
      ],
    });

    expect(stripOf(IMPLEMENT, failed, "needs-human")).toBe("claim ✓ → agent ✓ → gate ✓ → ask ✓");

    const broke = history({
      nodes: [ok("claim", 1), visit("agent", 3, { to: 4, outcome: "failed" })],
    });

    expect(stripOf(IMPLEMENT, broke, "failed")).toBe("claim ✓ → agent ✗ → gate · → pr ·");
  });

  test("a parked run waits at the node it is parked in", () => {
    const parked = history({ nodes: [ok("claim", 1), visit("agent", 3)], waits: [parkedOn] });

    expect(stripOf(IMPLEMENT, parked, "running")).toBe("claim ✓ → agent ‖ → gate · → pr ·");
  });

  test("inside a repeat, the current round's body", () => {
    const second = history({
      nodes: [
        ok("claim", 1),
        visit("rounds", 2),
        ok("implement", 3, { round: 1 }),
        ok("ci", 5, { round: 1 }),
        ok("fix", 7, { round: 1 }),
        visit("implement", 9, {}, { round: 2 }),
      ],
      branches: [
        RunBranch.make({
          node: NodeRef.make({ id: "ci", round: 1 }),
          outcome: "fail",
          takenAt: at(6),
        }),
      ],
    });

    expect(stripOf(LOOP, second, "running")).toBe("claim ✓ → implement ● → ci · → report ·");
  });

  test("a forEach is one node, with how many of its lanes are done", () => {
    const lanes = history({
      nodes: [
        ok("plan", 1),
        visit("tasks", 2),
        ok("implement", 3, { lane: "task-1" }),
        ok("ci", 5, { lane: "task-1" }),
        ok("implement", 3, { lane: "task-2" }),
        visit("ci", 5, {}, { lane: "task-2" }),
        visit("implement", 4, {}, { lane: "task-3" }),
      ],
    });

    expect(stripOf(EPIC, lanes, "running")).toBe("plan ✓ → tasks 1/3 ● → close ·");
  });
});

describe("a strip shortened to fit", () => {
  const far = history({
    nodes: [ok("claim", 1), ok("agent", 3), visit("gate", 5)],
  });

  test("whole, when it fits", () => {
    expect(stripOf(IMPLEMENT, far, "running", 33)).toBe("claim ✓ → agent ✓ → gate ● → pr ·");
  });

  test("drops the earliest finished nodes first, behind a …", () => {
    expect(stripOf(IMPLEMENT, far, "running", 32)).toBe("… → agent ✓ → gate ● → pr ·");
    expect(stripOf(IMPLEMENT, far, "running", 26)).toBe("… → gate ● → pr ·");
  });

  test("then the nodes ahead, from the last, and always keeps the current node", () => {
    expect(stripOf(IMPLEMENT, far, "running", 16)).toBe("… → gate ● → …");
    expect(stripOf(IMPLEMENT, far, "running", 14)).toBe("… → gate ● → …");
  });

  test("below a usable width, none, and the row keeps its detail", () => {
    expect(stripOf(IMPLEMENT, far, "running", 13)).toBe("(no strip)");
  });
});

// --- In the main view ------------------------------------------------------

const row = (id: string, itemKey: string, status: RunStatus) =>
  RunView.make({
    id: RunId.make(id),
    repo: "goodbones",
    persona: Option.none(),
    flow: "implement",
    itemKey,
    itemTitle: Option.some("Fix the parser"),
    itemUrl: Option.none(),
    executionId: Option.some("x"),
    status,
    currentStep: Option.as(
      Option.liftPredicate(status, (is) => is === "running"),
      "run-agent",
    ),
    summary: Option.as(
      Option.liftPredicate(status, (is) => is !== "running"),
      "#7: ready for review",
    ),
    startedAt: at(0),
    finishedAt: Option.as(
      Option.liftPredicate(status, (is) => is !== "running"),
      at(10),
    ),
  });

const status: DaemonStatus = {
  pid: 4242,
  startedAt: at(0),
  busy: 1,
  reloadPending: false,
  repos: [
    {
      name: "goodbones",
      slug: "dataquail/goodbones",
      status: "ready",
      message: Option.none(),
      paused: false,
      enabled: true,
      tree: Option.some("abc"),
      launcher: Option.none(),
      flows: [],
    },
  ],
  active: [
    ActiveRun.make({ ...row("run-planned", "issue-7", "running"), parked: false }),
    ActiveRun.make({ ...row("run-unplanned", "issue-8", "running"), parked: false }),
  ],
  recent: [row("run-finished", "issue-9", "done")],
  skips: [],
};

const model = (overrides: Partial<Model> = {}): Model => ({
  ...initialModel(140, 40, now),
  status: Option.some(status),
  now,
  plans: {
    "run-planned": { steps: IMPLEMENT, history: AT_AGENT },
    "run-finished": {
      steps: IMPLEMENT,
      history: history({ nodes: [ok("claim", 1), ok("agent", 3), ok("gate", 5), ok("pr", 7)] }),
    },
  },
  ...overrides,
});

describe("the main view's run rows", () => {
  test("a run with a plan shows its strip in place of its detail", () => {
    const screen = plain(view(model()));

    expect(screen).toMatch(/running\s+#7 .* claim ✓ → agent ● → gate · → pr ·/);
    expect(screen).toMatch(/done\s+#9 .* claim ✓ → agent ✓ → gate ✓ → pr ✓/);
  });

  test("a run with no plan keeps today's detail", () => {
    expect(plain(view(model()))).toMatch(/running\s+#8 .* 1h ago\s+run-agent$/m);
  });

  test("a row too narrow for the strip falls back to today's detail", () => {
    const narrow = plain(view(model({ width: 64 })));

    expect(narrow).toMatch(/running\s+#7 .* 1h ago\s+run-agent$/m);
    expect(narrow).not.toContain("agent ●");
    // A shorter strip still fits: the finished run keeps its last node.
    expect(narrow).toMatch(/done\s+#9 .* 60m ago\s+… → pr ✓$/m);
  });
});
