// A flow's plan as the canvas draws it (plan-canvas.tsx), worked out by walking
// its tree: a document is nested sequences and forks, so it needs no general
// graph layout. The boxes lay themselves out as the tree nests; this says
// which arrows join them.
//
// - A sequence is a chain: an arrow from each step to the next.
// - A block's outcome branches fork from it: an arrow to a label of each
//   outcome, and on from the label to the branch. A branch that doesn't end
//   rejoins the chain at the step after the fork, as the block itself does.
// - An end is terminal: no arrow leaves it.
// - A repeat, an if and a forEach are frames, one box in their chain, with
//   their steps chained inside. A repeat loops back to its start, from the
//   frame and from each `next` in it.
//
// It also finds a node by its id, gives a run's node states (RunOnPlan) by
// node id, and says where each input of a block or a stage comes from.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { NodeOnPlan, NodeState, PlanNode, RunOnPlan } from "#daemon/protocol";

export type PlanEdge = {
  readonly from: string;
  readonly to: string;
  // On along a chain, out of a block to one of its outcomes, or back to the
  // start of a repeat.
  readonly kind: "next" | "branch" | "loop";
};

// Each node's state in a run, by its id.
export type NodeStates = ReadonlyMap<string, NodeState>;

// The id of a block's outcome label, which the arrows to its branch pass through.
export const outcomeNode = (node: string, outcome: string) => `${node}:${outcome}`;

// A chain of steps: the arrows within it, and the nodes an arrow leaves it
// from for whatever comes after it, none when it ends.
type Chain = { readonly edges: ReadonlyArray<PlanEdge>; readonly exits: ReadonlyArray<string> };

const EMPTY: Chain = { edges: [], exits: [] };

// The repeat a `next` goes back to the start of, if the node is in one.
type Loop = Option.Option<string>;

const loopBack = (from: string, loop: Loop): ReadonlyArray<PlanEdge> =>
  Option.toArray(Option.map(loop, (to): PlanEdge => ({ from, to, kind: "loop" })));

type WalkChain = (steps: ReadonlyArray<PlanNode>, loop: Loop) => Chain;

// One node: the arrows within it, and those it leaves from for the step after.
const walkNode = (walkChain: WalkChain, node: PlanNode, loop: Loop): Chain => {
  switch (node.kind) {
    case "use":
    case "stage": {
      const branches = node.branches.map((branch) => {
        const label = outcomeNode(node.id, branch.outcome);
        const inner = walkChain(branch.steps, loop);

        const edges: ReadonlyArray<PlanEdge> = [
          { from: node.id, to: label, kind: "branch" },
          ...Option.toArray(
            Option.map(Arr.head(branch.steps), (first): PlanEdge => ({
              from: label,
              to: first.id,
              kind: "next",
            })),
          ),
          ...inner.edges,
        ];

        return { edges, exits: inner.exits };
      });

      return {
        edges: branches.flatMap((branch) => branch.edges),
        exits: [node.id, ...branches.flatMap((branch) => branch.exits)],
      };
    }

    case "end":
      return EMPTY;
    case "next":
      return { edges: loopBack(node.id, loop), exits: [] };
    case "first":
      return { edges: [], exits: [node.id] };
    case "if":
      return { edges: walkChain(node.steps, loop).edges, exits: [node.id] };
    case "forEach":
      return { edges: walkChain(node.steps, Option.none()).edges, exits: [node.id] };
    case "repeat":
      return {
        edges: [
          ...walkChain(node.steps, Option.some(node.id)).edges,
          { from: node.id, to: node.id, kind: "loop" },
        ],
        exits: [node.id],
      };
  }
};

const walkChain: WalkChain = (steps, loop) =>
  Arr.reduce(steps, EMPTY, (sofar, node) => {
    const walked = walkNode(walkChain, node, loop);
    const into = sofar.exits.map((from): PlanEdge => ({ from, to: node.id, kind: "next" }));

    return { edges: [...sofar.edges, ...into, ...walked.edges], exits: walked.exits };
  });

// Every arrow of a plan.
export const planEdges = (steps: ReadonlyArray<PlanNode>): ReadonlyArray<PlanEdge> =>
  walkChain(steps, Option.none()).edges;

// The nodes a node holds: a block's branches' steps, a frame's steps.
export const childrenOf = (node: PlanNode): ReadonlyArray<PlanNode> => {
  switch (node.kind) {
    case "use":
    case "stage":
      return node.branches.flatMap((branch) => branch.steps);
    case "repeat":
    case "forEach":
    case "if":
      return node.steps;
    case "end":
    case "next":
    case "first":
      return [];
  }
};

const everyNode = (steps: ReadonlyArray<PlanNode>): ReadonlyArray<PlanNode> =>
  steps.flatMap((node) => [node, ...everyNode(childrenOf(node))]);

// A node of the plan, by its id.
export const nodeById = (steps: ReadonlyArray<PlanNode>, id: string): Option.Option<PlanNode> =>
  Arr.findFirst(everyNode(steps), (node) => node.id === id);

// A node on the run and what it holds: its branches' steps, and what a view
// draws inside it (an if's steps, a repeat's latest round, a forEach's body).
const onPlanNodes = (nodes: ReadonlyArray<NodeOnPlan>): ReadonlyArray<NodeOnPlan> =>
  nodes.flatMap((node) => [
    node,
    ...onPlanNodes(node.branches.flatMap((branch) => branch.steps)),
    ...onPlanNodes(node.body),
  ]);

// A run's node states, as the runs module puts its history on its plan, by
// node id: a repeat's nodes as its latest round has them.
export const nodeStates = (run: RunOnPlan): NodeStates =>
  new Map(onPlanNodes(run.steps).map((node) => [node.node.id, node.state]));

// An input of a block or a stage: its name, whether a wire (`in`) or a
// value (`with`) gives it, and that wire or value.
export type PlanInput = {
  readonly name: string;
  readonly under: "in" | "with";
  readonly from: string;
};

type Wiring = { readonly [input: string]: Schema.Json };

const JsonText = Schema.fromJsonString(Schema.Json);

// A wire or a value as the document wrote it: a string as it is, anything
// else as JSON.
const shown = (value: Schema.Json): string =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(value), () =>
    Schema.encodeSync(JsonText)(value),
  );

const inputsUnder = (wiring: Wiring, under: PlanInput["under"]): ReadonlyArray<PlanInput> =>
  Object.entries(wiring).map(([name, value]) => ({ name, under, from: shown(value) }));

// Where each input of a block or a stage comes from; none for another node.
export const inputsOf = (node: PlanNode): ReadonlyArray<PlanInput> => {
  if (node.kind === "use" || node.kind === "stage") {
    return [...inputsUnder(node.in, "in"), ...inputsUnder(node.with, "with")];
  }

  return [];
};
