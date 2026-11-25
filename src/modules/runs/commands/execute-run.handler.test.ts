import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { type WorkItem } from "../domain/run/work-item.value-object.ts";
import {
  type FakeEngine,
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { executeRunHandler } from "./execute-run.handler.ts";

const handed: WorkItem = { key: "issue-7", title: "Fix it", data: { issue: 7 } };

// A run the hub recorded, as it hands it over.
const recorded = (id: string, fields: Partial<RunView> = {}) =>
  RunView.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-11-25T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const runtime = (engine: FakeEngine) =>
  Layer.mergeAll(WorkflowsClientFake(engine), PassThroughUnitOfWork);

describe("executeRunHandler", () => {
  effect("executes the run its hub handed over, in its journal, reading no store", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      const run = yield* executeRunHandler({ run: recorded("a"), item: handed });

      expect(run.executionId).toEqual(Option.some("execution-a"));
      expect(engine.executed).toEqual([RunId.make("a")]);
      expect(engine.journals).toEqual([RunId.make("a")]);
    }).pipe(Effect.provide(runtime(engine)));
  });

  effect("refuses a run that has ended, such as one cancelled before its spoke started", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({
          run: recorded("gone", {
            status: "cancelled",
            finishedAt: Option.some("2026-11-25T00:01:00.000Z"),
          }),
          item: handed,
        }),
      );

      expect(refused._tag).toBe("RunAlreadyFinished");
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine)));
  });

  effect("refuses a run another spoke already executes, so it isn't replayed twice", () => {
    const engine = fakeEngine();
    // The first spoke's journal.
    engine.journals.push(RunId.make("b"));

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(executeRunHandler({ run: recorded("b"), item: handed }));

      expect(refused._tag).toBe("RunAlreadyActive");
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine)));
  });

  effect("refuses a run no hub attached an execution to, and executes nothing", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({
          run: recorded("d", { executionId: Option.none() }),
          item: handed,
        }),
      );

      expect([refused._tag, refused.message]).toEqual([
        "FlowFailed",
        "run d has no execution: a hub records one with the run before it hands it over",
      ]);
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine)));
  });

  effect("refuses a run of a flow this process didn't load", () => {
    const engine = fakeEngine();
    engine.unloaded.push("demo/implement");

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(executeRunHandler({ run: recorded("c"), item: handed }));

      expect(refused._tag).toBe("FlowFailed");
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine)));
  });
});
