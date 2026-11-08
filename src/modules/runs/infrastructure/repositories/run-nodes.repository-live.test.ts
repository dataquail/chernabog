import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { type NodeMark } from "../../domain/run/node-mark.value-object.ts";
import { RunNodeEntity } from "../../domain/run/run-node.entity.ts";
import { RunNodeSpecifications } from "../../domain/run/run-node.specification.ts";
import { RunNodesRepository } from "../../domain/run/run-nodes.repository.ts";
import { RunNodesRepositoryLive } from "./run-nodes.repository-live.ts";

const markOf = (
  runId: string,
  mark: NodeMark,
  node: string,
  round: Option.Option<number>,
  lane: Option.Option<string>,
  at: string,
) =>
  RunNodeEntity.make({
    runId: RunId.make(runId),
    mark,
    node,
    round,
    lane,
    at,
    finishedAt: Option.none(),
    outcome: Option.none(),
  });

describe("RunNodesRepositoryLive", () => {
  effect("keeps each mark a run leaves, in order, and how it left the node it names", () =>
    Effect.gen(function* () {
      const marks = yield* RunNodesRepository;
      const inLane = markOf("a", "node", "claim", Option.some(1), Option.some("task-10"), "T1");
      const onMain = markOf("a", "node", "claim", Option.none(), Option.none(), "T2");
      yield* marks.insertOne(inLane);
      yield* marks.insertOne(markOf("b", "node", "claim", Option.none(), Option.none(), "T1"));
      yield* marks.insertOne(onMain);
      yield* marks.insertOne(
        RunNodeEntity.make({
          ...markOf("a", "branch", "review", Option.none(), Option.none(), "T3"),
          outcome: Option.some("approve"),
        }),
      );

      // Leaving the node on the main line leaves the one in the lane as it is.
      yield* marks.updateOne(
        RunNodeEntity.make({
          ...onMain,
          finishedAt: Option.some("T4"),
          outcome: Option.some("ok"),
        }),
      );

      expect(yield* marks.findMany(RunNodeSpecifications.forRun(RunId.make("a")))).toEqual([
        inLane,
        RunNodeEntity.make({
          ...onMain,
          finishedAt: Option.some("T4"),
          outcome: Option.some("ok"),
        }),
        RunNodeEntity.make({
          ...markOf("a", "branch", "review", Option.none(), Option.none(), "T3"),
          outcome: Option.some("approve"),
        }),
      ]);
    }).pipe(Effect.provide(RunNodesRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
