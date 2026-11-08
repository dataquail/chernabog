// A run row's strip: the run's main path through its plan, as RunOnPlan
// draws it, in the room the row leaves for its detail:
//
//   claim ✓ → agent ● → gate · → pr ·
//
// The path is the nodes the run took, the one it is in, and the ones ahead on
// the path it is most likely to take: down an outcome branch it took, past
// those it didn't, and on through the steps after a node that hasn't chosen
// one yet. An `if` and a `repeat` show their steps in line, a repeat those of
// its current round; a `forEach` is one node, with how many of its lanes are
// done; a `next` and a `first` run nothing and show nothing; and the path
// stops at an `end`.
//
// Too long for its room, the strip drops the earliest nodes before the
// current one first, behind a `…`, then the last nodes ahead of it, behind
// another. It always keeps the current node: the one the run is in, else the
// last it ran, else the first. When even that doesn't fit, there is no strip,
// and the row shows its detail as it did before.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import type { NodeOnPlan, NodeState, RunOnPlan } from "../daemon/daemon.protocol.ts";
import type { Line, Segment, Style } from "./line.ts";

// A node on the strip: what it says, and its state.
type Stop = { readonly label: string; readonly state: NodeState };

// The stops along a sequence of steps, and whether the path ended in it.
type Walked = { readonly stops: ReadonlyArray<Stop>; readonly ended: boolean };

const lanesDone = (node: NodeOnPlan) => node.lanes.filter((lane) => lane.state === "ok").length;

const forEachLabel = (node: NodeOnPlan) => {
  if (node.lanes.length === 0) {
    return node.node.id;
  }

  return `${node.node.id} ${lanesDone(node)}/${node.lanes.length}`;
};

const NOTHING: Walked = { stops: [], ended: false };

const walk = (steps: ReadonlyArray<NodeOnPlan>): Walked => {
  // One step's stops, and whether the path ends there.
  const stopsOf = (step: NodeOnPlan): Walked => {
    const { node } = step;

    if (step.state === "not-taken" || node.kind === "next" || node.kind === "first") {
      return NOTHING;
    }

    if (node.kind === "end") {
      return { stops: [], ended: true };
    }

    if (node.kind === "use" || node.kind === "stage") {
      const taken = Option.match(
        Arr.findFirst(step.branches, (branch) => branch.taken),
        { onNone: () => NOTHING, onSome: (branch) => walk(branch.steps) },
      );

      return { stops: [{ label: node.id, state: step.state }, ...taken.stops], ended: taken.ended };
    }

    if (node.kind === "forEach") {
      return { stops: [{ label: forEachLabel(step), state: step.state }], ended: false };
    }

    // An if's steps, or a repeat's current round.
    return walk(step.body);
  };

  return Arr.reduce(steps, NOTHING, (sofar, step): Walked => {
    if (sofar.ended) {
      return sofar;
    }

    const here = stopsOf(step);

    return { stops: [...sofar.stops, ...here.stops], ended: here.ended };
  });
};

const onlyIf = <A>(condition: boolean, items: ReadonlyArray<A>): ReadonlyArray<A> => {
  if (condition) {
    return items;
  }

  return [];
};

const LIVE: ReadonlyArray<NodeState> = ["running", "waiting"];

const RAN: ReadonlyArray<NodeState> = ["ok", "failed"];

// The node the run is in, else the last it ran, else the first.
const currentOf = (stops: ReadonlyArray<Stop>) =>
  Option.getOrElse(
    Option.orElse(
      Arr.findFirstIndex(stops, (stop) => LIVE.includes(stop.state)),
      () => Arr.findLastIndex(stops, (stop) => RAN.includes(stop.state)),
    ),
    () => 0,
  );

const GLYPH: Readonly<Record<NodeState, string>> = {
  ok: "✓",
  failed: "✗",
  running: "●",
  waiting: "‖",
  "not-taken": "·",
  "not-reached": "·",
};

const GLYPH_STYLE: Readonly<Record<NodeState, Style>> = {
  ok: "green",
  failed: "red",
  running: "cyan",
  waiting: "yellow",
  "not-taken": "dim",
  "not-reached": "dim",
};

const labelStyle = (state: NodeState): Style => {
  if (state === "not-reached" || state === "not-taken") {
    return "dim";
  }

  return "plain";
};

const ARROW = " → ";
const MORE = "…";

// The stops from `from` up to `to`, with a `…` for those dropped either side.
const shown = (stops: ReadonlyArray<Stop>, from: number, to: number): Line => {
  const more: Segment = { text: MORE, style: "dim" };
  const arrow: Segment = { text: ARROW, style: "dim" };

  const parts: ReadonlyArray<ReadonlyArray<Segment>> = [
    ...onlyIf(from > 0, [[more]]),
    ...stops.slice(from, to).map((stop): ReadonlyArray<Segment> => [
      { text: stop.label, style: labelStyle(stop.state) },
      { text: ` ${GLYPH[stop.state]}`, style: GLYPH_STYLE[stop.state] },
    ]),
    ...onlyIf(to < stops.length, [[more]]),
  ];

  return parts.flatMap((part, index) => [...onlyIf(index > 0, [arrow]), ...part]);
};

const widthOf = (line: Line) => line.reduce((sum, part) => sum + part.text.length, 0);

// The strip of a run on its plan in `width` columns; none when the run's path
// is empty, or its current node doesn't fit.
export const runStrip = (onPlan: RunOnPlan, width: number): Option.Option<Line> => {
  const { stops } = walk(onPlan.steps);
  const current = currentOf(stops);

  if (stops.length === 0) {
    return Option.none();
  }

  let from = 0;
  let to = stops.length;

  while (widthOf(shown(stops, from, to)) > width && from < current) {
    from += 1;
  }

  while (widthOf(shown(stops, from, to)) > width && to > current + 1) {
    to -= 1;
  }

  return Option.liftPredicate(shown(stops, from, to), (line) => widthOf(line) <= width);
};
