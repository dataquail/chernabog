import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLaneSpecifications } from "../domain/run/run-lane.specification.ts";
import { RunLanesRepository } from "../domain/run/run-lanes.repository.ts";
import { RunLanesRepositoryFake } from "../infrastructure/repositories/run-lanes.repository-fake.ts";
import { declareLaneHandler } from "./declare-lane.handler.ts";

const a = RunId.make("a");

const lanesOf = (runId: RunId) =>
  Effect.gen(function* () {
    const found = yield* (yield* RunLanesRepository).findMany(RunLaneSpecifications.forRun(runId));

    return found.map((lane) => [lane.lane, lane.needs]);
  });

describe("declareLaneHandler", () => {
  effect("records which lanes each lane waited on, adding to what it declared before", () =>
    Effect.gen(function* () {
      yield* declareLaneHandler({ runId: a, lane: "task-1", needs: [] });
      yield* declareLaneHandler({ runId: a, lane: "task-3", needs: ["task-1"] });
      yield* declareLaneHandler({
        runId: a,
        lane: "task-3",
        needs: ["task-2", "task-1", "task-3"],
      });
      yield* declareLaneHandler({ runId: RunId.make("b"), lane: "task-3", needs: ["task-9"] });

      expect(yield* lanesOf(a)).toEqual([
        ["task-1", []],
        ["task-3", ["task-1", "task-2"]],
      ]);
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunLanesRepositoryFake([])))),
  );

  effect("a resumed run declaring its lanes again changes nothing", () =>
    Effect.gen(function* () {
      for (let round = 0; round < 2; round++) {
        yield* declareLaneHandler({ runId: a, lane: "task-1", needs: [] });
        yield* declareLaneHandler({ runId: a, lane: "task-2", needs: ["task-1"] });
      }

      expect(yield* lanesOf(a)).toEqual([
        ["task-1", []],
        ["task-2", ["task-1"]],
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunLanesRepositoryFake([])))),
  );
});
