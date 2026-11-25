import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import {
  type FakeEngine,
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { sweepJournalsHandler } from "./sweep-journals.handler.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const runtime = (engine: FakeEngine, runs: ReadonlyArray<RunRoot>) =>
  Layer.mergeAll(RunsRepositoryFake(runs), WorkflowsClientFake(engine), PassThroughUnitOfWork);

describe("sweepJournalsHandler", () => {
  effect("deletes the journals of runs that aren't running, and keeps a running run's", () => {
    const engine = fakeEngine();
    engine.journals.push(RunId.make("live"), RunId.make("done"), RunId.make("unknown"));

    return Effect.gen(function* () {
      const swept = yield* sweepJournalsHandler();

      expect(swept.swept).toEqual(["done", "unknown"]);
      expect(engine.discarded.map(String)).toEqual(["done", "unknown"]);
      expect(engine.journals.map(String)).toEqual(["live"]);
      expect((yield* sweepJournalsHandler()).swept).toEqual([]);
    }).pipe(
      Effect.provide(
        runtime(engine, [
          run("live"),
          run("done", { status: "done", finishedAt: Option.some("2026-10-21T00:00:00.000Z") }),
        ]),
      ),
    );
  });

  effect("executes nothing, even for a running run with no execution", () => {
    const engine = fakeEngine();

    return Effect.gen(function* () {
      expect((yield* sweepJournalsHandler()).swept).toEqual([]);
      expect(engine.executed).toEqual([]);
    }).pipe(Effect.provide(runtime(engine, [run("unstarted", { executionId: Option.none() })])));
  });
});
