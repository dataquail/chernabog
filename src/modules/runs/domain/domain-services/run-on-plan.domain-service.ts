// A run's history put on its plan: what state each node of the plan is in,
// when the run entered and left it, and the engine steps it ran there. The
// dashboard's canvas and the TUI both draw a run from this, so they agree
// about every node, and neither works a node's state out for itself. A
// domain service, since it reads two aggregates: the plan a run started with
// and the run's history.
//
// A node is in a state:
//
// - `ok` or `failed`, as the run left it;
// - `running` while the run is in it, or `waiting` while the run is parked on
//   a signal (RunNeedsAttention) in it;
// - `not-taken` for a branch the run went past: an outcome branch for another
//   outcome, a step whose condition didn't hold;
// - `not-reached` for a node the run hasn't got to, or never will because it
//   ended first.
//
// A run records the nodes it enters and leaves, the branches it takes and the
// ends it reaches, each at its node in the round of the repeat and the lane
// of the forEach it ran in (NodeRef). The rest is read from those: an `if`
// from its steps, a `repeat` from its rounds, a `next` or a `first`, which run
// nothing, from whether the run went on past them. A repeat gives each of its
// rounds, with its body's states, so a view can show any round; a forEach
// gives each of its lanes, with its body's states, laid out by the lanes'
// `needs` (LaneLayouts).
//
// Engine steps that ran at no node, such as the subject's scope reading the
// trigger, letting its claim go, or telling a person of a failure, go to set
// up, before the plan, when they ran before the run entered any node of it,
// and to wrap up, after it, otherwise.
//
// A run that failed left its plan at the node that failed last; nothing after
// that point ran, so every node after it is not-reached.
//
// A round of a repeat is found from the nodes directly in its body, and a lane
// of a forEach from the nodes directly in its body and the lane's own steps:
// not from inside a repeat or a forEach nested in either, whose nodes carry
// their own round or lane.

import * as Option from "effect/Option";

import { type PlanNode } from "../plan/flow-plan.value-object.ts";
import { type NodeRef } from "../plan/node-ref.value-object.ts";
import { type RunHistory, type RunStep } from "../run/run-history.value-object.ts";
import { type RunStatus } from "../run/run-status.value-object.ts";
import { type LaneEdge } from "./lane-layout.domain-service.ts";

export type NodeState = "ok" | "failed" | "running" | "waiting" | "not-taken" | "not-reached";

// A node of the plan with the run on it, in a round of the repeat and a lane
// of the forEach it is in, each none outside one.
export type NodeOnPlan = {
  readonly node: PlanNode;
  readonly round: Option.Option<number>;
  readonly lane: Option.Option<string>;
  readonly state: NodeState;
  readonly startedAt: Option.Option<string>;
  readonly endedAt: Option.Option<string>;
  // The engine steps the run ran at this node, in the order it entered them.
  readonly steps: ReadonlyArray<RunStep>;
  // Whether the run left its plan here, by failing.
  readonly left: boolean;
  // A block's or a stage's outcome branches.
  readonly branches: ReadonlyArray<BranchOnPlan>;
  // What a view draws inside the node: an if's steps, a repeat's latest
  // round, or the body of a forEach that has no lane yet.
  readonly body: ReadonlyArray<NodeOnPlan>;
  // A repeat's rounds, the first first.
  readonly rounds: ReadonlyArray<RoundOnPlan>;
  // A forEach's lanes, in the order they started, by column and with arrows
  // from the forEach's node (its id) and from each lane to those that waited on it.
  readonly lanes: ReadonlyArray<LaneOnPlan>;
  readonly columns: ReadonlyArray<ReadonlyArray<string>>;
  readonly edges: ReadonlyArray<LaneEdge>;
};

export type BranchOnPlan = {
  readonly outcome: string;
  readonly taken: boolean;
  readonly steps: ReadonlyArray<NodeOnPlan>;
};

export type RoundOnPlan = {
  readonly round: number;
  readonly state: NodeState;
  readonly startedAt: Option.Option<string>;
  readonly endedAt: Option.Option<string>;
  readonly steps: ReadonlyArray<NodeOnPlan>;
};

export type LaneOnPlan = {
  readonly lane: string;
  readonly needs: ReadonlyArray<string>;
  readonly column: number;
  readonly state: NodeState;
  readonly startedAt: Option.Option<string>;
  readonly endedAt: Option.Option<string>;
  // The steps the lane's scope ran outside any node of its body.
  readonly steps: ReadonlyArray<RunStep>;
  readonly body: ReadonlyArray<NodeOnPlan>;
};

// Set up or wrap up: the engine steps that ran before the plan, or after it.
export type OffPlan = {
  readonly state: NodeState;
  readonly startedAt: Option.Option<string>;
  readonly endedAt: Option.Option<string>;
  readonly steps: ReadonlyArray<RunStep>;
};

export type RunOnPlan = {
  readonly setUp: OffPlan;
  readonly steps: ReadonlyArray<NodeOnPlan>;
  readonly wrapUp: OffPlan;
  // Where the run left its plan by failing; none for a run that didn't.
  readonly left: Option.Option<NodeRef>;
};

// How the run is, beyond its history.
export type RunFacts = { readonly status: RunStatus };

// Not yet: every node drawn ok, with nothing on it.
const nothing: OffPlan = {
  state: "ok",
  startedAt: Option.none(),
  endedAt: Option.none(),
  steps: [],
};

const draw = (
  plan: { readonly steps: ReadonlyArray<PlanNode> },
  _history: RunHistory,
  _run: RunFacts,
): RunOnPlan => ({
  setUp: nothing,
  steps: plan.steps.map((node) => ({
    node,
    round: Option.none(),
    lane: Option.none(),
    state: "ok",
    startedAt: Option.none(),
    endedAt: Option.none(),
    steps: [],
    left: false,
    branches: [],
    body: [],
    rounds: [],
    lanes: [],
    columns: [],
    edges: [],
  })),
  wrapUp: nothing,
  left: Option.none(),
});

export const RunOnPlan = { draw } as const;
