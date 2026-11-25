import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type WorkItem } from "../domain/run/work-item.value-object.ts";
import {
  type FakeEngine,
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { executeRunHandler } from "./execute-run.handler.ts";

const handed: WorkItem = { key: "issue-7", title: "Fix it", data: { issue: 7 } };

// A run the hub recorded.
const recorded = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.some(handed),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-11-25T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const runtime = (engine: FakeEngine, runs: ReadonlyArray<RunRoot>) =>
  Layer.mergeAll(RunsRepositoryFake(runs), WorkflowsClientFake(engine), PassThroughUnitOfWork);

describe("executeRunHandler", () => {
  effect("executes a run the hub recorded and attached, in its journal, writing nothing", () => {
    const engine = fakeEngine();
    const attached = recorded("a");

    return Effect.gen(function* () {
      const run = yield* executeRunHandler({ runId: RunId.make("a"), item: handed });

      const stored = yield* (yield* RunsRepository).findOne(
        RunSpecifications.withId(RunId.make("a")),
      );

      expect(run.executionId).toEqual(Option.some("execution-a"));
      expect(stored).toEqual(Option.some(attached));
      expect(engine.executed).toEqual([RunId.make("a")]);
      expect(engine.journals).toEqual([RunId.make("a")]);
    }).pipe(Effect.provide(runtime(engine, [attached])));
  });

  effect("refuses a run it can't find, and executes nothing", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({ runId: RunId.make("missing"), item: handed }),
      );

      expect(refused._tag).toBe("RunNotFound");
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine, [])));
  });

  effect("refuses a run that has ended, such as one cancelled before its spoke started", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({ runId: RunId.make("gone"), item: handed }),
      );

      expect(refused._tag).toBe("RunAlreadyFinished");
      expect(engine.executed).toEqual([]);
    }).pipe(
      Effect.provide(
        runtime(engine, [
          recorded("gone", {
            status: "cancelled",
            finishedAt: Option.some("2026-11-25T00:01:00.000Z"),
          }),
        ]),
      ),
    );
  });

  effect("refuses a run another spoke already executes, so it isn't replayed twice", () => {
    const engine = fakeEngine();
    // The first spoke's journal.
    engine.journals.push(RunId.make("b"));

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({ runId: RunId.make("b"), item: handed }),
      );

      expect(refused._tag).toBe("RunAlreadyActive");
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine, [recorded("b")])));
  });

  effect("refuses a run no hub attached an execution to, and executes nothing", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({ runId: RunId.make("d"), item: handed }),
      );

      expect([refused._tag, refused.message]).toEqual([
        "FlowFailed",
        "run d has no execution: a hub records one with the run before it hands it over",
      ]);
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine, [recorded("d", { executionId: Option.none() })])));
  });

  effect("refuses a run of a flow this process didn't load", () => {
    const engine = fakeEngine();
    engine.unloaded.push("demo/implement");

    return Effect.gen(function* () {
      const refused = yield* Effect.flip(
        executeRunHandler({ runId: RunId.make("c"), item: handed }),
      );

      expect(refused._tag).toBe("FlowFailed");
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine, [recorded("c")])));
  });
});
