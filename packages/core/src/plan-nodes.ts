// Plan nodes: where in its flow's plan a run went, as a page draws it on the
// plan. A flow compiled from a flow document runs each block, stage and lane
// at its node (CurrentNode), records each node it enters and how it left it,
// each outcome branch it took and each end it reached. The engine records
// them against the run and knows nothing of what a node is. A workflow body
// runs again whenever its run resumes, so each record is safe to repeat:
// recording one again changes nothing.

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { CurrentNode, type NodeAt } from "./flow.ts";
import { type StepOutcome } from "./services.ts";

// Records where in its plan a run went. Provided by Chernabog.
export class RunNodes extends Context.Service<
  RunNodes,
  {
    // The run entered the node, the first time it does.
    entered(at: NodeAt): Effect.Effect<void>;
    // The run left the node, with how, the first time it does.
    finished(at: NodeAt, outcome: StepOutcome): Effect.Effect<void>;
    // The node's block ended with `outcome`, and the run took its branch.
    branched(at: NodeAt, outcome: string): Effect.Effect<void>;
    // The run, or the lane it is in, reached the `end` at this node.
    ended(at: NodeAt): Effect.Effect<void>;
  }
>()("@chernabog/sdk/RunNodes") {}

const recording = (use: (nodes: RunNodes["Service"]) => Effect.Effect<void>) =>
  Effect.serviceOption(RunNodes).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: use })),
  );

// The node `id` in the round `round`, in the lane the fiber is in.
const nodeAt = (id: string, round: Option.Option<number>) =>
  Effect.map(CurrentNode, (current): NodeAt => ({
    id,
    round,
    lane: Option.flatMap(current, (outer) => outer.lane),
  }));

// How the node's effect ended; none when it was interrupted, since it runs
// again when its run resumes.
const outcomeOf = <A, E>(exit: Exit.Exit<A, E>): Option.Option<StepOutcome> => {
  if (Exit.isSuccess(exit)) {
    return Option.some("ok");
  }

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return Option.none();
  }

  return Option.some("failed");
};

// Runs `effect` at the node `id`, in the round `round` of the repeat it is in
// (none outside one), and in the lane the fiber is in: what it runs is in
// that node, and the run records entering it and how it left it.
export const at =
  (id: string, round: Option.Option<number>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(nodeAt(id, round), (node) =>
      recording((nodes) => nodes.entered(node)).pipe(
        Effect.andThen(effect),
        Effect.onExit((exit) =>
          Option.match(outcomeOf(exit), {
            onNone: () => Effect.void,
            onSome: (outcome) => recording((nodes) => nodes.finished(node, outcome)),
          }),
        ),
        Effect.provideService(CurrentNode, Option.some(node)),
      ),
    );

// Runs `effect` in the lane `lane` of the node the fiber is in, as a forEach
// runs each of its lanes. Outside any node, as in a flow with no plan, it
// runs as it is.
export const inLane =
  (lane: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(CurrentNode, (current) =>
      Effect.provideService(
        effect,
        CurrentNode,
        Option.map(current, (node) => ({ ...node, lane: Option.some(lane) })),
      ),
    );

// Records that the block at the node `id` ended with `outcome`, and the run took its branch.
export const branched = (id: string, round: Option.Option<number>, outcome: string) =>
  Effect.flatMap(nodeAt(id, round), (node) => recording((nodes) => nodes.branched(node, outcome)));

// Records that the run, or the lane it is in, reached the end at the node `id`.
export const ended = (id: string, round: Option.Option<number>) =>
  Effect.flatMap(nodeAt(id, round), (node) => recording((nodes) => nodes.ended(node)));
