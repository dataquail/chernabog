// Where in its plan each step of a document's run ran: each block, stage and
// lane of a generated flow runs at its plan node (core's CurrentNode), so a
// run's history and log say, for every step, which node it was in, and the
// round of the repeat and the lane of the forEach it ran in. A block that runs
// no step is entered and left all the same, and the branches a run took and
// the end it reached are recorded once, however often a resumed run passes them.

import { type Flow, PlanNodes } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunLogLines } from "../src/kernel/run-log-line.value-object.ts";
import { FlowPlan } from "../src/modules/runs/domain/plan/flow-plan.value-object.ts";
import { RunLogsClient } from "../src/modules/runs/domain/ports/clients/run-logs.client.ts";
import { type RunHistory } from "../src/modules/runs/domain/run/run-history.value-object.ts";
import { readFlowPlanHandler } from "../src/modules/runs/queries/read-flow-plan.handler.ts";
import { readRunHistoryHandler } from "../src/modules/runs/queries/read-run-history.handler.ts";
import {
  documentOf,
  EPIC_DOCUMENT,
  generated,
  loadModule,
  loadSource,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";
import {
  EPIC_SCENARIOS,
  EPIC_WORK_ITEM,
  type FlowInput,
  observe,
  REVIEW_SCENARIOS,
  REVIEW_WORK_ITEM,
  type Scenario,
} from "./compose-scenarios.ts";
import { effect } from "./effect-test.ts";

type NodeSaid = {
  readonly id: string;
  readonly round?: number;
  readonly lane?: string;
};

// A node as one line: its id, then its round and lane where it has them; `-` for none.
const said = (node: Option.Option<NodeSaid>) =>
  Option.match(node, {
    onNone: () => "-",
    onSome: (found) =>
      [
        found.id,
        ...Option.toArray(Option.map(Option.fromUndefinedOr(found.round), (round) => `r${round}`)),
        ...Option.toArray(Option.fromUndefinedOr(found.lane)),
      ].join(" "),
  });

// Where in its plan a run went, as its history has it.
const pathOf = (history: RunHistory) => ({
  steps: history.steps.map((step) => `${step.step} @ ${said(Option.fromUndefinedOr(step.node))}`),
  nodes: (history.nodes ?? []).map(
    (visit) => `${said(Option.some(visit.node))}: ${visit.outcome ?? "-"}`,
  ),
  branches: (history.branches ?? []).map(
    (branch) => `${said(Option.some(branch.node))}: ${branch.outcome}`,
  ),
  ends: (history.ends ?? []).map((end) => said(Option.some(end.node))),
});

type Path = ReturnType<typeof pathOf>;

const NodeTag = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    round: Schema.optionalKey(Schema.Int),
    lane: Schema.optionalKey(Schema.String),
  }),
);

// Each `step:` line of a run's log, with the node its tag names.
const loggedSteps = (log: string) =>
  log
    .split("\n")
    .filter((line) => / step: /.test(RunLogLines.untagged(line)))
    .map((line) => {
      const step = RunLogLines.untagged(line).replace(/^\S+ step: /, "");
      const node = Option.map(RunLogLines.nodeOf(line), Schema.decodeUnknownSync(NodeTag));

      return `${step} @ ${said(node)}`;
    });

type Seen = {
  readonly path: Path;
  readonly logged: ReadonlyArray<string>;
  readonly plan: Option.Option<string>;
  readonly kept: Option.Option<string>;
};

// Runs the flow through the engine as the differential tests do, and reads
// where in its plan the run went as it stops being followed.
const runOf = (
  flow: Flow,
  name: string,
  work: Parameters<typeof observe>[3],
  scenario: Scenario,
  settings: FlowInput = scenario.settings,
) =>
  Effect.gen(function* () {
    let seen = Option.none<Seen>();

    const observed = yield* observe(
      flow,
      name,
      scenario.setup,
      work,
      scenario.wake,
      settings,
      (run) =>
        Effect.gen(function* () {
          const history = yield* readRunHistoryHandler({ runId: run.id }).pipe(Effect.orDie);
          const log = yield* (yield* RunLogsClient).readFrom(run.id, 0).pipe(Effect.orDie);
          const plan = Option.fromUndefinedOr(history.plan);

          const kept = yield* Effect.forEach(Option.toArray(plan), (hash) =>
            readFlowPlanHandler({ hash }),
          );

          seen = Option.some({
            path: pathOf(history),
            logged: loggedSteps(Option.getOrElse(log, () => "")),
            plan,
            kept: Option.flatMap(Option.fromIterable(kept), (found) =>
              Option.map(
                Option.flatMap(found.plan, Schema.decodeUnknownOption(FlowPlan)),
                (keptPlan) => keptPlan.hash,
              ),
            ),
          });
        }),
    );

    expect(observed.status).toBe(scenario.ends);

    return Option.getOrThrow(seen);
  });

const scenarioOf = (scenarios: ReadonlyArray<Scenario>, title: string) =>
  Option.getOrThrow(Option.fromUndefinedOr(scenarios.find((each) => each.title === title)));

// The epic run that opens #10 and #12, then #11 in the next round, parks in
// the third with nothing to start, and once every task merged, wakes, replays
// the rounds before and ends in the fourth.
const EPIC_RUN = scenarioOf(EPIC_SCENARIOS, "when every task merges, and the run wakes and ends");

// A task's lane, one step after another, in its round.
const laneSteps = (task: number, round: number, review: number) => {
  const at = (node: string) => `${node} r${round} task-${task}`;

  return [
    `claim#task-${task} @ ${at("claim")}`,
    `prepare-worktree#task-${task} @ ${at("worktree")}`,
    `implement#task-${task} @ ${at("agent")}`,
    `local-gate-1#task-${task} @ ${at("gate")}`,
    // One block, three steps.
    `task-base#task-${task} @ ${at("published")}`,
    `push#task-${task} @ ${at("published")}`,
    `open-pull-request#task-${task} @ ${at("published")}`,
    `ci-1-1#task-${task} @ ${at("ci")}`,
    `hand-off#task-${task} @ ${at("done")}`,
    `request-review-${review} @ ${at("done")}`,
  ];
};

const laneNodes = (task: number, round: number) =>
  ["claim", "worktree", "agent", "gate", "published", "ci", "done"].map(
    (node) => `${node} r${round} task-${task}: ok`,
  );

// The nodes of a round of the epic's repeat up to its forEach, none of which
// but progress and status runs a step.
const roundNodes = (round: number) =>
  ["progress", "status", "noted", "closed", "carried", "ready"].map(
    (node) => `${node} r${round}: ok`,
  );

const EPIC_STEPS = [
  "claim-epic @ claimed",
  "ships @ ships",
  "at-once @ howMany",
  "epic-tasks-1 @ progress r1",
  "epic-status-1 @ status r1",
  ...laneSteps(10, 1, 200),
  ...laneSteps(12, 1, 201),
  "epic-tasks-2 @ progress r2",
  "epic-status-2 @ status r2",
  ...laneSteps(11, 2, 202),
  "epic-tasks-3 @ progress r3",
  "epic-status-3 @ status r3",
  // The layer #11 opened on #10's branch, carried up once #10 merged: one block, five steps.
  "stack-base-3#202 @ carried r3",
  "prepare-worktree#refresh-202-base1234 @ carried r3",
  "refresh-head-202-base1234 @ carried r3",
  "update-from-base#refresh-202-base1234 @ carried r3",
  "refresh-diff-202-base1234 @ carried r3",
  // Nothing to start: the run parks, at the node of the branch it took.
  "await-layer-changed:epic-3 @ parked r3",
  "epic-tasks-4 @ progress r4",
  "epic-status-4 @ status r4",
  // The subject's claim, let go as the run ends, outside any node.
  "release-claim-epic-40 @ -",
];

const EPIC_NODES = [
  "claimed: ok",
  "ships: ok",
  "howMany: ok",
  ...roundNodes(1),
  "started r1: ok",
  ...laneNodes(10, 1),
  ...laneNodes(12, 1),
  "recorded r1: ok",
  ...roundNodes(2),
  "started r2: ok",
  ...laneNodes(11, 2),
  "recorded r2: ok",
  ...roundNodes(3),
  "parked r3: ok",
  "progress r4: ok",
  "status r4: ok",
  "noted r4: ok",
  "closed r4: ok",
];

// The branches it took, and the end it reached, each once: the run passed
// the third round's branch again when it woke, and recorded nothing new.
const EPIC_BRANCHES = ["ready r3: none", "closed r4: finished"];

const EPIC_ENDS = ["steps[3].repeat.steps[3].on.finished.steps[0] r4"];

const epicDocument = documentOf(EPIC_DOCUMENT);

describe("a document's run records where in its plan each step ran", () => {
  effect(
    "in an epic's repeat and forEach: each step's node, round and lane, every node it passed, its branches and its end",
    () =>
      Effect.gen(function* () {
        const module = yield* loadModule(generated(epicDocument));
        const seen = yield* runOf(module.default, "epic", EPIC_WORK_ITEM, EPIC_RUN);

        expect(seen.path).toEqual({
          steps: EPIC_STEPS,
          nodes: EPIC_NODES,
          branches: EPIC_BRANCHES,
          ends: EPIC_ENDS,
        });

        // Its log tags each step's line with the step's node too.
        expect(seen.logged).toEqual(EPIC_STEPS);

        // It kept the plan it started with, which the daemon answers by its hash.
        expect(seen.plan).toEqual(Option.some(module.plan.hash));
        expect(seen.kept).toEqual(Option.some(module.plan.hash));
      }),
    60_000,
  );

  effect(
    "in a document with no repeat or forEach: no round and no lane, and the branch and end it took",
    () =>
      Effect.gen(function* () {
        const module = yield* loadModule(generated(documentOf(REVIEW_DOCUMENT)));

        const seen = yield* runOf(
          module.default,
          "review",
          REVIEW_WORK_ITEM,
          scenarioOf(REVIEW_SCENARIOS, "when it approves a pull request on the automated path"),
        );

        expect(seen.path.steps.every((step) => / @ (review|land)$/.test(step))).toBe(true);
        expect(seen.path.steps.length).toBeGreaterThan(1);
        expect(seen.path.nodes).toEqual(["review: ok", "land: ok"]);
        expect(seen.path.branches).toEqual(["review: approve"]);
        expect(seen.path.ends).toEqual(["steps[0].on.approve.steps[1]"]);
        expect(seen.plan).toEqual(Option.some(module.plan.hash));
      }),
    60_000,
  );

  effect(
    "a generated flow that drops a block's node puts that block's steps at the wrong node",
    () =>
      Effect.gen(function* () {
        const source = generated(epicDocument);
        const atClaim = `.pipe(PlanNodes.at("claim", Option.some(round)))`;
        const sabotaged = source.replace(atClaim, "");

        expect(sabotaged).not.toBe(source);

        const seen = yield* runOf(yield* loadSource(sabotaged), "epic", EPIC_WORK_ITEM, EPIC_RUN);

        expect(seen.path.steps).not.toEqual(EPIC_STEPS);
        // The claim's steps are in the forEach's node, which is all the lane knows.
        expect(seen.path.steps).toContain("claim#task-10 @ started r1 task-10");
      }),
    60_000,
  );
});

describe("PlanNodes outside a run", () => {
  effect("runs what it wraps as it is, and records nothing, with no RunNodes provided", () =>
    Effect.gen(function* () {
      const result = yield* Effect.succeed(7).pipe(
        PlanNodes.at("claim", Option.some(2)),
        PlanNodes.inLane("task-1"),
      );

      expect(result).toBe(7);
      yield* PlanNodes.branched("claim", Option.none(), "approve");
      yield* PlanNodes.ended("steps[1]", Option.none());
    }),
  );
});
