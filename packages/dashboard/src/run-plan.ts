// A run on the plan it started with, as its page draws it (run-canvas.tsx):
// the runs module puts the run's history on its plan (RunOnPlan), and this
// says what the page needs of that. Each node of the run sits at a place, its
// node in a round of its repeat and a lane of its forEach, which keys its box
// on the canvas (`ci@2#task-10`, as a NodeRef keys it) and names its page
// (routes.ts). A repeat shows one round at a time: the one picked, else the
// one a link to a node names, else its latest. The arrows join the boxes as
// they do on a flow's plan (plan-graph.ts), with set up before the plan and
// wrap up after it, and a forEach's lanes joined by what each waited on.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import {
  type FlowPlan,
  type LaneOnPlan,
  type NodeOnPlan,
  type NodeState,
  type OffPlan,
  type RoundOnPlan,
  type RunHistory,
  RunOnPlan,
  type RunOnPlanFacts,
} from "#daemon/protocol";

import { outcomeNode, type PlanEdge } from "./plan-graph.ts";
import type { NodePlace } from "./routes.ts";
import { span } from "./time.tsx";

type Drawn = RunOnPlan;

// The run on its plan, for a run that has one.
export const runOnPlan = (
  plan: Option.Option<FlowPlan>,
  history: RunHistory,
  run: RunOnPlanFacts,
): Option.Option<Drawn> =>
  Option.map(plan, (kept) => RunOnPlan.draw(kept, history, { status: run.status }));

// The key of a place: its node's id, `@` its round, `#` its lane.
export const keyOf = (id: string, round: Option.Option<number>, lane: Option.Option<string>) =>
  [
    id,
    ...Option.toArray(Option.map(round, (at) => `@${at}`)),
    ...Option.toArray(Option.map(lane, (at) => `#${at}`)),
  ].join("");

export const SET_UP = "set-up";
export const WRAP_UP = "wrap-up";

export const nodeKey = (node: NodeOnPlan) => keyOf(node.node.id, node.round, node.lane);

// A lane's key: its forEach's node, in the forEach's round, in the lane.
export const laneKey = (forEach: NodeOnPlan, lane: string) =>
  keyOf(forEach.node.id, forEach.round, Option.some(lane));

export const placeKey = (place: NodePlace) => {
  switch (place.kind) {
    case "set-up":
      return SET_UP;
    case "wrap-up":
      return WRAP_UP;
    case "node":
      return keyOf(place.id, place.round, place.lane);
  }
};

export const placeOf = (node: NodeOnPlan): NodePlace => ({
  kind: "node",
  id: node.node.id,
  round: node.round,
  lane: node.lane,
});

export const lanePlace = (forEach: NodeOnPlan, lane: string): NodePlace => ({
  kind: "node",
  id: forEach.node.id,
  round: forEach.round,
  lane: Option.some(lane),
});

// The round each repeat shows, by the repeat's key.
export type Rounds = ReadonlyMap<string, number>;

// The round a repeat shows: the one in `rounds`, else its latest; none for
// a repeat the run hasn't started.
export const shownRound = (node: NodeOnPlan, rounds: Rounds): Option.Option<RoundOnPlan> =>
  Option.orElse(
    Option.flatMap(Option.fromUndefinedOr(rounds.get(nodeKey(node))), (picked) =>
      Arr.findFirst(node.rounds, (round) => round.round === picked),
    ),
    () => Arr.last(node.rounds),
  );

// What a frame shows inside it: a repeat its round's steps, the others what
// the run's model draws there.
export const bodyOf = (node: NodeOnPlan, rounds: Rounds): ReadonlyArray<NodeOnPlan> => {
  if (node.node.kind !== "repeat") {
    return node.body;
  }

  return Option.match(shownRound(node, rounds), {
    onNone: () => node.body,
    onSome: (round) => round.steps,
  });
};

// Every node of the run, in every round of each repeat and every lane of
// each forEach.
const everyNode = (nodes: ReadonlyArray<NodeOnPlan>): ReadonlyArray<NodeOnPlan> =>
  nodes.flatMap((node) => [
    node,
    ...everyNode(node.branches.flatMap((branch) => branch.steps)),
    ...everyNode(node.body),
    ...everyNode(node.rounds.flatMap((round) => round.steps)),
    ...everyNode(node.lanes.flatMap((lane) => lane.body)),
  ]);

// What is at a place on the run's plan: a node, a lane of a forEach, or set
// up or wrap up.
export type Located =
  | { readonly kind: "node"; readonly node: NodeOnPlan }
  | { readonly kind: "lane"; readonly forEach: NodeOnPlan; readonly lane: LaneOnPlan }
  | { readonly kind: "off"; readonly name: string; readonly off: OffPlan };

export const locate = (run: Drawn, place: NodePlace): Option.Option<Located> => {
  switch (place.kind) {
    case "set-up":
      return Option.some({ kind: "off", name: "Set up", off: run.setUp });
    case "wrap-up":
      return Option.some({ kind: "off", name: "Wrap up", off: run.wrapUp });
    case "node": {
      const key = placeKey(place);
      const nodes = everyNode(run.steps);

      return Option.orElse(
        Option.map(
          Arr.findFirst(nodes, (node) => nodeKey(node) === key),
          (node): Located => ({ kind: "node", node }),
        ),
        () =>
          Arr.findFirst(nodes, (node) =>
            Option.map(
              Arr.findFirst(node.lanes, (lane) => laneKey(node, lane.lane) === key),
              (lane): Located => ({ kind: "lane", forEach: node, lane }),
            ),
          ),
      );
    }
  }
};

// The round each repeat shows for a link to the place keyed `key`: the round
// of the repeat the place is in.
export const roundsFor = (run: Drawn, key: Option.Option<string>): Rounds => {
  const holds = (steps: ReadonlyArray<NodeOnPlan>) =>
    everyNode(steps).some(
      (node) =>
        Option.contains(key, nodeKey(node)) ||
        node.lanes.some((lane) => Option.contains(key, laneKey(node, lane.lane))),
    );

  return new Map(
    everyNode(run.steps).flatMap((node) =>
      Option.toArray(
        Option.map(
          Arr.findFirst(node.rounds, (round) => holds(round.steps)),
          (round) => [nodeKey(node), round.round] as const,
        ),
      ),
    ),
  );
};

// --- Arrows -------------------------------------------------------------

type Chain = { readonly edges: ReadonlyArray<PlanEdge>; readonly exits: ReadonlyArray<string> };

const EMPTY: Chain = { edges: [], exits: [] };

type WalkChain = (
  steps: ReadonlyArray<NodeOnPlan>,
  loop: Option.Option<string>,
  rounds: Rounds,
) => Chain;

const walkNode = (
  walkChain: WalkChain,
  node: NodeOnPlan,
  loop: Option.Option<string>,
  rounds: Rounds,
): Chain => {
  const key = nodeKey(node);

  switch (node.node.kind) {
    case "use":
    case "stage": {
      const branches = node.branches.map((branch) => {
        const label = outcomeNode(key, branch.outcome);
        const inner = walkChain(branch.steps, loop, rounds);

        const edges: ReadonlyArray<PlanEdge> = [
          { from: key, to: label, kind: "branch" },
          ...Option.toArray(
            Option.map(Arr.head(branch.steps), (first): PlanEdge => ({
              from: label,
              to: nodeKey(first),
              kind: "next",
            })),
          ),
          ...inner.edges,
        ];

        return { edges, exits: inner.exits };
      });

      return {
        edges: branches.flatMap((branch) => branch.edges),
        exits: [key, ...branches.flatMap((branch) => branch.exits)],
      };
    }

    case "end":
      return EMPTY;
    case "next":
      return {
        edges: Option.toArray(
          Option.map(loop, (to): PlanEdge => ({ from: key, to, kind: "loop" })),
        ),
        exits: [],
      };
    case "first":
      return { edges: [], exits: [key] };
    case "if":
      return { edges: walkChain(node.body, loop, rounds).edges, exits: [key] };
    case "repeat":
      return {
        edges: [
          ...walkChain(bodyOf(node, rounds), Option.some(key), rounds).edges,
          { from: key, to: key, kind: "loop" },
        ],
        exits: [key],
      };
    case "forEach": {
      const inLanes = node.lanes.flatMap(
        (lane) => walkChain(lane.body, Option.none(), rounds).edges,
      );

      // Arrows from a lane to those that waited on it; those from the
      // forEach itself to the lanes that waited on none go without saying.
      const between = node.edges
        .filter((edge) => edge.from !== node.node.id)
        .map((edge): PlanEdge => ({
          from: laneKey(node, edge.from),
          to: laneKey(node, edge.to),
          kind: "next",
        }));

      return {
        edges: [...walkChain(node.body, Option.none(), rounds).edges, ...inLanes, ...between],
        exits: [key],
      };
    }
  }
};

const walkChain: WalkChain = (steps, loop, rounds) =>
  Arr.reduce(steps, EMPTY, (sofar, node) => {
    const walked = walkNode(walkChain, node, loop, rounds);
    const into = sofar.exits.map((from): PlanEdge => ({ from, to: nodeKey(node), kind: "next" }));

    return { edges: [...sofar.edges, ...into, ...walked.edges], exits: walked.exits };
  });

// Every arrow of the run as its canvas shows it, each repeat at its round.
export const runEdges = (run: Drawn, rounds: Rounds): ReadonlyArray<PlanEdge> => {
  const chain = walkChain(run.steps, Option.none(), rounds);

  return [
    ...Option.toArray(
      Option.map(Arr.head(run.steps), (first): PlanEdge => ({
        from: SET_UP,
        to: nodeKey(first),
        kind: "next",
      })),
    ),
    ...chain.edges,
    ...chain.exits.map((from): PlanEdge => ({ from, to: WRAP_UP, kind: "next" })),
  ];
};

// --- What a node says ---------------------------------------------------

type Timed = {
  readonly state: NodeState;
  readonly startedAt: Option.Option<string>;
  readonly endedAt: Option.Option<string>;
};

// When the run parked on what it waits on: its earliest wait's.
export const parkedSince = (history: RunHistory): Option.Option<string> =>
  Arr.head(
    Arr.sort(
      history.waits.flatMap((wait) => Option.toArray(wait.parkedAt)),
      Order.mapInput(Order.Number, Date.parse),
    ),
  );

// A node's time: how long it took, how long it has been running, or how long
// it has been parked; none for one the run never ran.
export const timeOf = (
  node: Timed,
  now: number,
  parked: Option.Option<string>,
): Option.Option<string> => {
  switch (node.state) {
    case "running":
      return Option.map(node.startedAt, (from) => span(now - Date.parse(from)));
    case "waiting":
      return Option.map(
        Option.orElse(parked, () => node.startedAt),
        (from) => `parked ${span(now - Date.parse(from))}`,
      );
    case "ok":
    case "failed":
      return Option.map(Option.all([node.startedAt, node.endedAt]), ([from, to]) =>
        span(Date.parse(to) - Date.parse(from)),
      );
    case "not-taken":
    case "not-reached":
      return Option.none();
  }
};

// The outcome a node reached: the branches it took, else how it ended.
export const outcomeOf = (node: Timed & Partial<Pick<NodeOnPlan, "branches">>) => {
  const taken = (node.branches ?? []).filter((branch) => branch.taken);

  if (taken.length > 0) {
    return Option.some(taken.map((branch) => branch.outcome).join(", "));
  }

  return Option.liftPredicate<string>(node.state, (state) => state === "ok" || state === "failed");
};
