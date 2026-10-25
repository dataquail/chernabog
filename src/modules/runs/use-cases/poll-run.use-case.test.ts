import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
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
import { pollRunUseCase } from "./poll-run.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    sdkVersion: "0.6.0",
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

describe("pollRunUseCase", () => {
  const engine = fakeEngine();

  effect("is the run while its workflow runs, and records how it ended once it has", () =>
    Effect.gen(function* () {
      const still = yield* pollRunUseCase(RunId.make("a"));
      engine.outcomes["execution-a"] = { status: "done", summary: "merged" };
      const ended = yield* pollRunUseCase(RunId.make("a"));

      expect(Option.map(still.run, (found) => found.status)).toEqual(Option.some("running"));
      expect(Option.map(ended.run, (found) => [found.status, found.summary])).toEqual(
        Option.some(["done", Option.some("merged")]),
      );
    }).pipe(Effect.provide(runtime(engine, { runs: [run("a")] }))),
  );
});
