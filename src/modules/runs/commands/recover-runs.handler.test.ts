import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { type WorkItem } from "../domain/run/work-item.value-object.ts";
import { type RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { type FakeFlow, FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import {
  type FakeEngine,
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { SkipsRepositoryFake } from "../infrastructure/repositories/skips.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { recoverRunsHandler } from "./recover-runs.handler.ts";

const item = (key: string, fields: Partial<WorkItem> = {}): WorkItem => ({
  key,
  data: {},
  ...fields,
});

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

// The runs module over these runs, waits and flows, and a fake engine.
const runtime = (
  engine: FakeEngine,
  stored: {
    readonly runs?: ReadonlyArray<RunRoot>;
    readonly waits?: ReadonlyArray<RunWaitRoot>;
    readonly flows?: Readonly<Record<string, FakeFlow>>;
  } = {},
) =>
  Layer.mergeAll(
    RunsRepositoryFake(stored.runs ?? []),
    RunWaitsRepositoryFake(stored.waits ?? []),
    SkipsRepositoryFake([]),
    FlowsClientFake(stored.flows ?? {}),
    WorkflowsClientFake(engine),
  );

const ids = (runs: ReadonlyArray<{ readonly id: RunId }>) => runs.map((found) => String(found.id));

describe("recoverRunsHandler", () => {
  const engine = fakeEngine();
  engine.unloaded.push("demo/elsewhere");

  effect(
    "executes a run a crash left without a workflow, ends one with no item, and leaves one it can't run",
    () =>
      Effect.gen(function* () {
        const recovered = yield* recoverRunsHandler();

        expect(ids(recovered.executed)).toEqual(["kept"]);
        expect(recovered.executed.map((found) => found.executionId)).toEqual([
          Option.some("execution-kept"),
        ]);
        expect(ids(recovered.abandoned)).toEqual(["legacy"]);
        expect(ids(recovered.left)).toEqual(["elsewhere"]);
        expect(engine.executed.map(String)).toEqual(["kept"]);

        const legacy = Option.getOrThrow(
          (yield* findRunHandler({ runId: RunId.make("legacy") })).run,
        );

        expect([legacy.status, legacy.summary]).toEqual([
          "failed",
          Option.some("interrupted before its workflow started"),
        ]);
        expect((yield* recoverRunsHandler()).executed).toEqual([]);
      }).pipe(
        Effect.provide(
          runtime(engine, {
            runs: [
              run("started"),
              run("kept", {
                itemKey: "pr-2",
                executionId: Option.none(),
                item: Option.some(item("pr-2")),
              }),
              run("legacy", { itemKey: "pr-3", executionId: Option.none() }),
              run("elsewhere", {
                flow: "elsewhere",
                executionId: Option.none(),
                item: Option.some(item("pr-1")),
              }),
              run("ended", { executionId: Option.none(), status: "done" }),
            ],
          }),
        ),
      ),
  );
});
