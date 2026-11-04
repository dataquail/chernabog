import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunLaneEntity } from "../../domain/run/run-lane.entity.ts";
import { RunLaneSpecifications } from "../../domain/run/run-lane.specification.ts";
import { RunLanesRepository } from "../../domain/run/run-lanes.repository.ts";
import { RunLanesRepositoryLive } from "./run-lanes.repository-live.ts";

const a = RunId.make("a");

const lane = (runId: RunId, name: string, needs: ReadonlyArray<string>) =>
  RunLaneEntity.make({ runId, lane: name, needs });

describe("RunLanesRepositoryLive", () => {
  effect("keeps each lane a run declared, in the order it first did, with what it needs now", () =>
    Effect.gen(function* () {
      const lanes = yield* RunLanesRepository;
      yield* lanes.upsertOne(lane(a, "task-1", []));
      yield* lanes.upsertOne(lane(RunId.make("b"), "task-1", ["task-0"]));
      yield* lanes.upsertOne(lane(a, "task-2", ["task-1"]));
      yield* lanes.upsertOne(lane(a, "task-1", ["task-0"]));

      expect(yield* lanes.findMany(RunLaneSpecifications.forRun(a))).toEqual([
        lane(a, "task-1", ["task-0"]),
        lane(a, "task-2", ["task-1"]),
      ]);
      expect(yield* lanes.findMany(RunLaneSpecifications.named(a, "task-2"))).toEqual([
        lane(a, "task-2", ["task-1"]),
      ]);
      expect(yield* lanes.findMany(RunLaneSpecifications.forRun(RunId.make("c")))).toEqual([]);
    }).pipe(Effect.provide(RunLanesRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
