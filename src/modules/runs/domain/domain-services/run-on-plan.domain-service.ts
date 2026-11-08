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

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { type PlanBranch, type PlanNode } from "../plan/flow-plan.value-object.ts";
import { type NodeRef, NodeRefs } from "../plan/node-ref.value-object.ts";
import { type RunHistory, type RunNodeVisit, RunStep } from "../run/run-history.value-object.ts";
import { type RunStatus } from "../run/run-status.value-object.ts";
import { type LaneEdge, LaneLayouts } from "./lane-layout.domain-service.ts";

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

type Place = { readonly round: Option.Option<number>; readonly lane: Option.Option<string> };

const OUTSIDE: Place = { round: Option.none(), lane: Option.none() };

const keyAt = (id: string, place: Place) => NodeRefs.keyOf(NodeRefs.of({ id, ...place }));

const time = (iso: string) => Date.parse(iso);

const byTime = Order.mapInput(Order.Number, time);

const earliest = (times: ReadonlyArray<string>) =>
  Arr.match(times, {
    onEmpty: () => Option.none<string>(),
    onNonEmpty: (some) => Option.some(Arr.min(some, byTime)),
  });

const latest = (times: ReadonlyArray<string>) =>
  Arr.match(times, {
    onEmpty: () => Option.none<string>(),
    onNonEmpty: (some) => Option.some(Arr.max(some, byTime)),
  });

const LIVE: ReadonlyArray<NodeState> = ["running", "waiting"];

const UNRUN: ReadonlyArray<NodeState> = ["not-taken", "not-reached"];

// Whether the run did anything at a node.
const touched = (state: NodeState) => !UNRUN.includes(state);

// A step that hasn't ended: no end kept and no outcome.
const open = (step: RunStep) =>
  Option.isNone(Option.fromUndefinedOr(step.finishedAt)) &&
  Option.isNone(Option.fromUndefinedOr(step.outcome));

// A run that resumes enters the step it was in again, and the history keeps
// each entry: those are one step, from its first entry, with the end and the
// outcome whichever entry kept them.
const once = (steps: ReadonlyArray<RunStep>): ReadonlyArray<RunStep> => {
  const keyOf = (step: RunStep) =>
    `${step.step}\t${Option.match(Option.fromUndefinedOr(step.node), {
      onNone: () => "",
      onSome: NodeRefs.keyOf,
    })}`;

  const ordered = Arr.sort(
    steps,
    Order.mapInput(byTime, (step: RunStep) => step.enteredAt),
  );

  return Arr.dedupeWith(ordered, (first, again) => keyOf(first) === keyOf(again)).map((first) => {
    const entries = ordered.filter((entry) => keyOf(entry) === keyOf(first));

    const finishedAt = Arr.findFirst(entries, (entry) =>
      Option.isSome(Option.fromUndefinedOr(entry.finishedAt)),
    ).pipe(Option.flatMap((entry) => Option.fromUndefinedOr(entry.finishedAt)));

    const outcome = Arr.findFirst(entries, (entry) =>
      Option.isSome(Option.fromUndefinedOr(entry.outcome)),
    ).pipe(Option.flatMap((entry) => Option.fromUndefinedOr(entry.outcome)));

    return RunStep.make({
      step: first.step,
      ...Option.match(Option.fromUndefinedOr(first.node), {
        onNone: () => ({}),
        onSome: (node) => ({ node }),
      }),
      enteredAt: first.enteredAt,
      ...Option.match(finishedAt, { onNone: () => ({}), onSome: (at) => ({ finishedAt: at }) }),
      ...Option.match(outcome, { onNone: () => ({}), onSome: (how) => ({ outcome: how }) }),
    });
  });
};

// What a run's history says, indexed by where in its plan it happened.
type Read = {
  readonly visits: ReadonlyMap<string, RunNodeVisit>;
  readonly branches: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly ends: ReadonlyMap<string, string>;
  readonly steps: ReadonlyMap<string, ReadonlyArray<RunStep>>;
  // Every place the run did anything, with the node's id.
  readonly marks: ReadonlyArray<NodeRef>;
  readonly lanes: ReadonlyArray<{ readonly lane: string; readonly needs: ReadonlyArray<string> }>;
  readonly running: boolean;
  readonly parked: boolean;
  readonly left: Option.Option<string>;
};

const grouped = <A>(items: ReadonlyArray<A>, key: (item: A) => string) => {
  const found = new Map<string, Array<A>>();

  for (const item of items) {
    const at = key(item);

    found.set(at, [...(found.get(at) ?? []), item]);
  }

  return found;
};

const stepsAt = (read: Read, key: string) => read.steps.get(key) ?? [];

// How a set of engine steps stands: failed if one failed, running while one
// is open in a running run, else ok.
const stepsState = (steps: ReadonlyArray<RunStep>, read: Read): NodeState => {
  if (steps.some((step) => step.outcome === "failed")) {
    return "failed";
  }

  if (read.running && steps.some(open)) {
    return "running";
  }

  return "ok";
};

// A node's state from its children's: failed if one failed, waiting or
// running if one is, ok once one ran and none runs; not-reached when none ran.
const gather = (states: ReadonlyArray<NodeState>): NodeState => {
  for (const state of ["failed", "waiting", "running"] satisfies ReadonlyArray<NodeState>) {
    if (states.includes(state)) {
      return state;
    }
  }

  if (states.some(touched)) {
    return "ok";
  }

  return "not-reached";
};

// The state of a node the run entered: how it left it, else running or, in a
// parked run, waiting at a node with no children of its own to be in. A run
// that ended without leaving it, as a cancelled run does, failed there.
const visitState = (visit: RunNodeVisit, read: Read, leaf: boolean): NodeState => {
  const outcome = Option.fromUndefinedOr(visit.outcome);

  if (Option.isSome(outcome)) {
    return outcome.value;
  }

  if (!read.running) {
    return "failed";
  }

  if (read.parked && leaf) {
    return "waiting";
  }

  return "running";
};

const EMPTY = {
  branches: [],
  body: [],
  rounds: [],
  lanes: [],
  columns: [],
  edges: [],
} as const;

// A node, and everything under it, the run never ran in this place.
const unrun = (node: PlanNode, place: Place, state: NodeState): NodeOnPlan => {
  const children = (steps: ReadonlyArray<PlanNode>) =>
    steps.map((child) => unrun(child, place, state));

  const base: NodeOnPlan = {
    node,
    ...place,
    state,
    startedAt: Option.none(),
    endedAt: Option.none(),
    steps: [],
    left: false,
    ...EMPTY,
  };

  if (node.kind === "use" || node.kind === "stage") {
    return {
      ...base,
      branches: node.branches.map((branch) => ({
        outcome: branch.outcome,
        taken: false,
        steps: children(branch.steps),
      })),
    };
  }

  if (node.kind === "if" || node.kind === "repeat" || node.kind === "forEach") {
    return { ...base, body: children(node.steps) };
  }

  return base;
};

// Ids of the nodes in `steps`, outcome branches and ifs included, not inside
// a repeat or a forEach nested there, which are themselves.
const directIds = (steps: ReadonlyArray<PlanNode>): ReadonlyArray<string> =>
  steps.flatMap((node) => {
    if (node.kind === "use" || node.kind === "stage") {
      return [node.id, ...node.branches.flatMap((branch) => directIds(branch.steps))];
    }

    if (node.kind === "if") {
      return [node.id, ...directIds(node.steps)];
    }

    return [node.id];
  });

type Walk = (node: PlanNode, place: Place, passed: boolean) => NodeOnPlan;

// Steps drawn so far, the later ones first, and whether the run went past them.
type Sequenced = { readonly drawn: ReadonlyArray<NodeOnPlan>; readonly passed: boolean };

// A sequence of steps in a place: each later one first, so a step knows
// whether the run went on past it. `passed` says whether it went past the
// whole sequence.
const sequence = (
  walk: Walk,
  steps: ReadonlyArray<PlanNode>,
  place: Place,
  passed: boolean,
): ReadonlyArray<NodeOnPlan> => {
  const start: Sequenced = { drawn: [], passed };

  return Arr.reduceRight(steps, start, (after, node): Sequenced => {
    const drawn = walk(node, place, after.passed);

    return { drawn: [drawn, ...after.drawn], passed: after.passed || touched(drawn.state) };
  }).drawn;
};

const spanOf = (
  nodes: ReadonlyArray<NodeOnPlan>,
  steps: ReadonlyArray<RunStep>,
  state: NodeState,
) => {
  const startedAt = earliest([
    ...nodes.flatMap((node) => Option.toArray(node.startedAt)),
    ...steps.map((step) => step.enteredAt),
  ]);

  if (LIVE.includes(state)) {
    return { startedAt, endedAt: Option.none<string>() };
  }

  return {
    startedAt,
    endedAt: latest([
      ...nodes.flatMap((node) => Option.toArray(node.endedAt)),
      ...steps.flatMap((step) => Option.toArray(Option.fromUndefinedOr(step.finishedAt))),
    ]),
  };
};

const unreached = (passed: boolean): NodeState => {
  if (passed) {
    return "not-taken";
  }

  return "not-reached";
};

const walker = (read: Read): Walk => {
  const walk: Walk = (node, place, passed) => {
    const key = keyAt(node.id, place);

    const base = {
      node,
      ...place,
      startedAt: Option.none<string>(),
      endedAt: Option.none<string>(),
      steps: stepsAt(read, key),
      left: Option.contains(read.left, key),
      ...EMPTY,
    };

    if (node.kind === "use" || node.kind === "stage") {
      return Option.match(Option.fromUndefinedOr(read.visits.get(key)), {
        onNone: () => unrun(node, place, unreached(passed)),
        onSome: (visit) => {
          const taken = read.branches.get(key) ?? [];
          const left = Option.isSome(Option.fromUndefinedOr(visit.outcome)) || taken.length > 0;

          const branchOf = (branch: PlanBranch): BranchOnPlan => {
            if (taken.includes(branch.outcome)) {
              return {
                outcome: branch.outcome,
                taken: true,
                steps: sequence(walk, branch.steps, place, passed),
              };
            }

            const state = unreached(left);

            return {
              outcome: branch.outcome,
              taken: false,
              steps: branch.steps.map((child) => unrun(child, place, state)),
            };
          };

          return {
            ...base,
            state: visitState(visit, read, true),
            startedAt: Option.some(visit.enteredAt),
            endedAt: Option.fromUndefinedOr(visit.finishedAt),
            branches: node.branches.map(branchOf),
          };
        },
      });
    }

    if (node.kind === "end") {
      return Option.match(Option.fromUndefinedOr(read.ends.get(key)), {
        onNone: () => unrun(node, place, unreached(passed)),
        onSome: (at): NodeOnPlan => ({
          ...base,
          state: "ok",
          startedAt: Option.some(at),
          endedAt: Option.some(at),
        }),
      });
    }

    if (node.kind === "next" || node.kind === "first") {
      if (passed) {
        return { ...base, state: "ok" };
      }

      return unrun(node, place, "not-reached");
    }

    if (node.kind === "if") {
      const body = sequence(walk, node.steps, place, passed);
      const state = gather(body.map((child) => child.state));

      if (!touched(state)) {
        return unrun(node, place, unreached(passed));
      }

      return { ...base, state, ...spanOf(body, [], state), body };
    }

    if (node.kind === "repeat") {
      const ids = new Set(directIds(node.steps));

      const rounds = Arr.sort(
        Arr.dedupe(
          read.marks
            .filter((mark) => ids.has(mark.id) && mark.lane === Option.getOrUndefined(place.lane))
            .flatMap((mark) => Option.toArray(NodeRefs.roundOf(mark))),
        ),
        Order.Number,
      );

      const last = Math.max(0, ...rounds);

      const drawn = rounds.map((round): RoundOnPlan => {
        const steps = sequence(
          walk,
          node.steps,
          { round: Option.some(round), lane: place.lane },
          passed || round < last,
        );

        const state = gather(steps.map((child) => child.state));

        return { round, state, ...spanOf(steps, [], state), steps };
      });

      return Option.match(Arr.last(drawn), {
        onNone: () => unrun(node, place, unreached(passed)),
        onSome: (latestRound): NodeOnPlan => {
          const state = gather(drawn.map((round) => round.state));

          return {
            ...base,
            state,
            startedAt: Option.flatMap(Arr.head(drawn), (first) => first.startedAt),
            endedAt: Option.flatMap(
              Option.liftPredicate(latestRound, () => !LIVE.includes(state)),
              (round) => round.endedAt,
            ),
            body: latestRound.steps,
            rounds: drawn,
          };
        },
      });
    }

    // A forEach.
    return Option.match(Option.fromUndefinedOr(read.visits.get(key)), {
      onNone: () => unrun(node, place, unreached(passed)),
      onSome: (visit) => {
        const ids = new Set([node.id, ...directIds(node.steps)]);
        const round = Option.getOrUndefined(place.round);
        const found = read.marks.filter((mark) => ids.has(mark.id) && mark.round === round);
        const laneIds = Arr.dedupe(found.flatMap((mark) => Option.toArray(NodeRefs.laneOf(mark))));
        const done = visit.outcome === "ok";

        const lanes = laneIds.map((lane) => {
          const at: Place = { round: place.round, lane: Option.some(lane) };
          const body = sequence(walk, node.steps, at, done);
          const steps = stepsAt(read, keyAt(node.id, at));

          const state = gather([
            ...body.map((child) => child.state),
            ...Option.toArray(Option.map(Arr.head(steps), () => stepsState(steps, read))),
          ]);

          return { lane, state, ...spanOf(body, steps, state), steps, body };
        });

        const ordered = Arr.sort(
          lanes,
          Order.mapInput(Order.Number, (lane: { readonly startedAt: Option.Option<string> }) =>
            Option.match(lane.startedAt, { onNone: () => Infinity, onSome: time }),
          ),
        );

        const layout = LaneLayouts.layOut(
          ordered.map((lane) => lane.lane),
          read.lanes,
          Option.some(node.id),
        );

        const laid = ordered.map((lane): LaneOnPlan => {
          const where = Option.fromUndefinedOr(
            layout.lanes.find((entry) => entry.lane === lane.lane),
          );

          return {
            ...lane,
            needs: Option.match(where, { onNone: () => [], onSome: (entry) => entry.needs }),
            column: Option.match(where, { onNone: () => 1, onSome: (entry) => entry.column }),
          };
        });

        const own = visitState(visit, read, laid.length === 0);

        const state = Option.match(Option.fromUndefinedOr(visit.outcome), {
          onSome: () => own,
          onNone: () => {
            const inLanes = gather(laid.map((lane) => lane.state));

            if (read.running && LIVE.includes(inLanes)) {
              return inLanes;
            }

            return own;
          },
        });

        const body = Option.match(Arr.head(laid), {
          onNone: () => node.steps.map((child) => unrun(child, place, "not-reached")),
          onSome: () => [],
        });

        return {
          ...base,
          state,
          startedAt: Option.some(visit.enteredAt),
          endedAt: Option.fromUndefinedOr(visit.finishedAt),
          body,
          lanes: laid,
          columns: LaneLayouts.columns(layout),
          edges: layout.edges,
        };
      },
    });
  };

  return walk;
};

// Every node of a plan, by its id.
const kindsOf = (steps: ReadonlyArray<PlanNode>): ReadonlyArray<PlanNode> =>
  steps.flatMap((node) => {
    if (node.kind === "use" || node.kind === "stage") {
      return [node, ...node.branches.flatMap((branch) => kindsOf(branch.steps))];
    }

    if (node.kind === "if" || node.kind === "repeat" || node.kind === "forEach") {
      return [node, ...kindsOf(node.steps)];
    }

    return [node];
  });

// Where a failed run left its plan: the block or stage that failed last, else
// whatever node failed first, as a failure leaves the innermost node first.
const leftAt = (
  plan: ReadonlyArray<PlanNode>,
  visits: ReadonlyArray<RunNodeVisit>,
): Option.Option<NodeRef> => {
  const leaves = new Set(
    kindsOf(plan)
      .filter((node) => node.kind === "use" || node.kind === "stage")
      .map((node) => node.id),
  );

  const failed = visits.filter((visit) => visit.outcome === "failed");
  const finished = (visit: RunNodeVisit) => time(visit.finishedAt ?? visit.enteredAt);

  return Option.orElse(
    Option.map(
      Arr.match(
        failed.filter((visit) => leaves.has(visit.node.id)),
        {
          onEmpty: () => Option.none<RunNodeVisit>(),
          onNonEmpty: (some) => Option.some(Arr.max(some, Order.mapInput(Order.Number, finished))),
        },
      ),
      (visit) => visit.node,
    ),
    () =>
      Option.map(
        Arr.match(failed, {
          onEmpty: () => Option.none<RunNodeVisit>(),
          onNonEmpty: (some) => Option.some(Arr.min(some, Order.mapInput(Order.Number, finished))),
        }),
        (visit) => visit.node,
      ),
  );
};

const offPlan = (steps: ReadonlyArray<RunStep>, state: NodeState): OffPlan => ({
  state,
  startedAt: earliest(steps.map((step) => step.enteredAt)),
  endedAt: Option.flatMap(
    Option.liftPredicate(steps, () => !LIVE.includes(state)),
    (ended) =>
      latest(ended.flatMap((step) => Option.toArray(Option.fromUndefinedOr(step.finishedAt)))),
  ),
  steps,
});

const draw = (
  plan: { readonly steps: ReadonlyArray<PlanNode> },
  history: RunHistory,
  run: RunFacts,
): RunOnPlan => {
  const steps = once(history.steps);
  const visits = history.nodes ?? [];
  const branches = history.branches ?? [];
  const ends = history.ends ?? [];
  const running = run.status === "running";

  const placed = steps.flatMap((step) =>
    Option.toArray(Option.map(Option.fromUndefinedOr(step.node), (node) => ({ node, step }))),
  );

  const unplaced = steps.filter((step) => Option.isNone(Option.fromUndefinedOr(step.node)));

  const left = Option.filter(leftAt(plan.steps, visits), () => run.status === "failed");

  const read: Read = {
    visits: new Map(visits.map((visit) => [NodeRefs.keyOf(visit.node), visit])),
    branches: new Map(
      [...grouped(branches, (branch) => NodeRefs.keyOf(branch.node))].map(([key, taken]) => [
        key,
        taken.map((branch) => branch.outcome),
      ]),
    ),
    ends: new Map(ends.map((reached) => [NodeRefs.keyOf(reached.node), reached.reachedAt])),
    steps: new Map(
      [...grouped(placed, (entry) => NodeRefs.keyOf(entry.node))].map(([key, entries]) => [
        key,
        entries.map((entry) => entry.step),
      ]),
    ),
    marks: [
      ...visits.map((visit) => visit.node),
      ...placed.map((entry) => entry.node),
      ...branches.map((branch) => branch.node),
      ...ends.map((reached) => reached.node),
    ],
    lanes: history.lanes ?? [],
    running,
    parked: running && history.waits.length > 0,
    left: Option.map(left, NodeRefs.keyOf),
  };

  const drawn = sequence(walker(read), plan.steps, OUTSIDE, false);

  // The plan began when the run first entered a node of it, or ran a step at one.
  const began = earliest([
    ...visits.map((visit) => visit.enteredAt),
    ...placed.map((entry) => entry.step.enteredAt),
  ]);

  const before = (step: RunStep) =>
    Option.match(began, { onNone: () => true, onSome: (at) => time(step.enteredAt) < time(at) });

  const setUpSteps = unplaced.filter(before);
  const wrapUpSteps = unplaced.filter((step) => !before(step));

  const setUp = Option.match(Arr.head(setUpSteps), {
    onNone: () => {
      if (running && Option.isNone(began)) {
        return offPlan([], "running");
      }

      return offPlan([], "ok");
    },
    onSome: () => offPlan(setUpSteps, stepsState(setUpSteps, read)),
  });

  const wrapUp = Option.match(Arr.head(wrapUpSteps), {
    onNone: () => {
      if (running || run.status === "failed") {
        return offPlan([], "not-reached");
      }

      return offPlan([], "ok");
    },
    onSome: () => offPlan(wrapUpSteps, stepsState(wrapUpSteps, read)),
  });

  return { setUp, steps: drawn, wrapUp, left };
};

export const RunOnPlan = { draw } as const;
