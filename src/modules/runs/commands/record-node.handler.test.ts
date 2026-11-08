import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { NodeRef } from "../domain/plan/node-ref.value-object.ts";
import {
  BranchTaken,
  EndReached,
  NodeEntered,
  NodeFinished,
} from "../domain/run/node-did.value-object.ts";
import { RunNodeSpecifications } from "../domain/run/run-node.specification.ts";
import { RunNodesRepository } from "../domain/run/run-nodes.repository.ts";
import { RunNodesRepositoryFake } from "../infrastructure/repositories/run-nodes.repository-fake.ts";
import { recordNodeHandler } from "./record-node.handler.ts";

const a = RunId.make("a");

const marks = Layer.mergeAll(RecordedEvents, RunNodesRepositoryFake([]));

const left = Effect.gen(function* () {
  const found = yield* (yield* RunNodesRepository).findMany(RunNodeSpecifications.forRun(a));

  return found.map((mark) => [
    mark.mark,
    mark.node,
    Option.getOrElse(mark.round, () => 0),
    Option.getOrElse(mark.lane, () => ""),
    Option.getOrElse(mark.outcome, () => ""),
    Option.isSome(mark.finishedAt),
  ]);
});

const eventIds = Effect.map(DispatchedEvents, (events) =>
  events.map((event) => [event._tag, event.eventId]),
);

const claim = NodeRef.make({ id: "claim", round: 2, lane: "task-10" });

describe("recordNodeHandler", () => {
  effect("records entering a node and leaving it, once each, however often it's told", () =>
    Effect.gen(function* () {
      for (const _ of [1, 2]) {
        yield* recordNodeHandler({ runId: a, node: claim, did: NodeEntered.make({}) });
        yield* recordNodeHandler({
          runId: a,
          node: claim,
          did: NodeFinished.make({ outcome: "ok" }),
        });
      }

      // A resumed run that leaves it again, another way, changes nothing.
      yield* recordNodeHandler({
        runId: a,
        node: claim,
        did: NodeFinished.make({ outcome: "failed" }),
      });

      expect(yield* left).toEqual([["node", "claim", 2, "task-10", "ok", true]]);
      expect(yield* eventIds).toEqual([
        ["RunEnteredNode", "a:node:claim@2#task-10"],
        ["RunFinishedNode", "a:node-finished:claim@2#task-10"],
      ]);
    }).pipe(Effect.provide(marks)),
  );

  effect("tells one node from another by its round and its lane", () =>
    Effect.gen(function* () {
      for (const node of [
        claim,
        NodeRef.make({ id: "claim", round: 3, lane: "task-10" }),
        NodeRef.make({ id: "claim", round: 2, lane: "task-11" }),
        NodeRef.make({ id: "claim" }),
      ]) {
        yield* recordNodeHandler({ runId: a, node, did: NodeEntered.make({}) });
      }

      expect(yield* left).toEqual([
        ["node", "claim", 2, "task-10", "", false],
        ["node", "claim", 3, "task-10", "", false],
        ["node", "claim", 2, "task-11", "", false],
        ["node", "claim", 0, "", "", false],
      ]);
    }).pipe(Effect.provide(marks)),
  );

  effect("leaves no node it never entered", () =>
    Effect.gen(function* () {
      yield* recordNodeHandler({
        runId: a,
        node: claim,
        did: NodeFinished.make({ outcome: "ok" }),
      });

      expect(yield* left).toEqual([]);
      expect(yield* eventIds).toEqual([]);
    }).pipe(Effect.provide(marks)),
  );

  effect(
    "records a branch taken and an end reached once, as a replayed branch passes them again",
    () =>
      Effect.gen(function* () {
        const review = NodeRef.make({ id: "review" });
        const end = NodeRef.make({ id: "steps[0].on.approve.steps[1]" });

        for (const _ of [1, 2]) {
          yield* recordNodeHandler({
            runId: a,
            node: review,
            did: BranchTaken.make({ outcome: "approve" }),
          });
          yield* recordNodeHandler({ runId: a, node: end, did: EndReached.make({}) });
        }

        expect(yield* left).toEqual([
          ["branch", "review", 0, "", "approve", false],
          ["end", "steps[0].on.approve.steps[1]", 0, "", "", false],
        ]);
        expect(yield* eventIds).toEqual([
          ["RunTookBranch", "a:branch:review"],
          ["RunReachedEnd", "a:end:steps[0].on.approve.steps[1]"],
        ]);
        expect((yield* DispatchedEvents)[0]).toMatchObject({
          runId: a,
          node: { id: "review" },
          outcome: "approve",
        });
      }).pipe(Effect.provide(marks)),
  );
});
