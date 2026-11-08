import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { type NodeRef, NodeRefs } from "../domain/plan/node-ref.value-object.ts";
import { type NodeMark } from "../domain/run/node-mark.value-object.ts";
import { type NodeEvent, RunEvents } from "../domain/run/run.events.ts";
import { RunNodeEntity } from "../domain/run/run-node.entity.ts";
import { RunNodeSpecifications } from "../domain/run/run-node.specification.ts";
import { RunNodesRepository } from "../domain/run/run-nodes.repository.ts";
import { type StepOutcome } from "../domain/run/step-outcome.value-object.ts";
import { type RecordNodePayload } from "./record-node.command.ts";

// The NodeRef a mark is at.
const refOf = (mark: RunNodeEntity) =>
  NodeRefs.of({ id: mark.node, round: mark.round, lane: mark.lane });

// The run's mark of this kind at the node, if it left one.
const markAt = (runId: RunId, mark: NodeMark, node: NodeRef) =>
  Effect.gen(function* () {
    const marks = yield* (yield* RunNodesRepository).findMany(RunNodeSpecifications.forRun(runId));

    return Arr.findFirst(marks, (each) => each.mark === mark && NodeRefs.same(refOf(each), node));
  });

// A new mark at the node, made now.
const markNow = (runId: RunId, mark: NodeMark, node: NodeRef, outcome: Option.Option<string>) =>
  Effect.map(DateTime.now, (now) =>
    RunNodeEntity.make({
      runId,
      mark,
      node: node.id,
      round: NodeRefs.roundOf(node),
      lane: NodeRefs.laneOf(node),
      at: DateTime.formatIso(now),
      finishedAt: Option.none(),
      outcome,
    }),
  );

// Leaves the mark once: a mark the run left at the node already stays as it is.
const markOnce = (
  runId: RunId,
  mark: NodeMark,
  node: NodeRef,
  outcome: Option.Option<string>,
  said: (made: RunNodeEntity) => NodeEvent,
) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* markAt(runId, mark, node))) {
      return;
    }

    const made = yield* markNow(runId, mark, node, outcome);
    yield* (yield* RunNodesRepository).insertOne(made);
    yield* (yield* EventBus).dispatch([said(made)]);
  });

// Leaves the node the run entered, once: one it never entered, or left
// already, stays as it is.
const leave = (runId: RunId, node: NodeRef, outcome: StepOutcome) =>
  Effect.gen(function* () {
    const open = Option.filter(yield* markAt(runId, "node", node), (entered) =>
      Option.isNone(entered.finishedAt),
    );

    for (const entered of Option.toArray(open)) {
      const finishedAt = DateTime.formatIso(yield* DateTime.now);

      yield* (yield* RunNodesRepository).updateOne(
        RunNodeEntity.make({
          ...entered,
          finishedAt: Option.some(finishedAt),
          outcome: Option.some(outcome),
        }),
      );
      yield* (yield* EventBus).dispatch([RunEvents.finishedNode(runId, node, outcome, finishedAt)]);
    }
  });

export const recordNodeHandler = Effect.fn("recordNodeHandler")(
  function* ({ did, node, runId }: RecordNodePayload) {
    yield* Match.value(did).pipe(
      Match.tagsExhaustive({
        NodeEntered: () =>
          markOnce(runId, "node", node, Option.none(), (made) =>
            RunEvents.enteredNode(runId, node, made.at),
          ),
        NodeFinished: (finished) => leave(runId, node, finished.outcome),
        BranchTaken: (taken) =>
          markOnce(runId, "branch", node, Option.some(taken.outcome), (made) =>
            RunEvents.tookBranch(runId, node, taken.outcome, made.at),
          ),
        EndReached: () =>
          markOnce(runId, "end", node, Option.none(), (made) =>
            RunEvents.reachedEnd(runId, node, made.at),
          ),
      }),
    );
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
