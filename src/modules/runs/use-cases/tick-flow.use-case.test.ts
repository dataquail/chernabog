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
import { listRecentSkipsUseCase } from "./list-recent-skips.use-case.ts";
import { tickFlowUseCase, type TickInput } from "./tick-flow.use-case.ts";

const review = { repo: "demo", flow: "review", persona: Option.some("bob") };

const item = (key: string, fields: Partial<WorkItem> = {}): WorkItem => ({
  key,
  data: {},
  ...fields,
});

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
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

const open: TickInput = {
  gates: true,
  item: Option.none(),
  conditions: {
    enabled: true,
    flowOff: Option.none(),
    paused: false,
    quietHours: Option.none(),
    activeHours: Option.none(),
  },
  routing: { assignee: Option.none(), reviewRequested: Option.none() },
  login: Option.some("bob"),
  concurrency: { flow: 1, machine: 4 },
};

const reasons = listRecentSkipsUseCase(5).pipe(
  Effect.map(({ skips }) => skips.map((skip) => skip.reason)),
);

describe("tickFlowUseCase", () => {
  const engine = fakeEngine();

  effect("starts a run for the work its trigger finds, up to the flow's limit", () =>
    Effect.gen(function* () {
      const outcome = yield* tickFlowUseCase(review, open);

      expect(outcome.started.map((found) => found.itemKey)).toEqual(["pr-1"]);
      expect(outcome.routed).toEqual(Option.some({ queued: ["pr-1 One", "pr-2"], elsewhere: [] }));
      expect(outcome.skipped).toEqual(Option.none());
    }).pipe(
      Effect.provide(
        runtime(engine, {
          flows: { "demo/review": { items: [item("pr-1", { title: "One" }), item("pr-2")] } },
        }),
      ),
    ),
  );

  effect("records why it starts nothing: the machine's gates, a failing trigger, the limit", () =>
    Effect.gen(function* () {
      yield* tickFlowUseCase(review, { ...open, conditions: { ...open.conditions, paused: true } });
      yield* tickFlowUseCase({ ...review, flow: "broken" }, open);
      yield* tickFlowUseCase(review, open);

      expect(yield* reasons).toContain("paused");
      expect(yield* reasons).toContain("trigger failed: rate limited");
      expect((yield* reasons).some((reason) => reason.startsWith("at the concurrency limit"))).toBe(
        true,
      );
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          runs: [run("busy", { itemKey: "pr-9" })],
          flows: {
            "demo/review": { items: [item("pr-1")] },
            "demo/broken": { items: [], fails: "rate limited" },
          },
        }),
      ),
    ),
  );

  effect("leaves work for others to them, and its gate holds every run back", () =>
    Effect.gen(function* () {
      const routed = yield* tickFlowUseCase(review, {
        ...open,
        routing: { assignee: Option.some(["@me"]), reviewRequested: Option.none() },
      });

      const gated = yield* tickFlowUseCase({ ...review, flow: "gated" }, open);

      expect(routed.skipped).toEqual(Option.some("only work for others: pr-1 (assignee: alice)"));
      expect(gated.skipped).toEqual(Option.some("usage gate: over the ceiling"));
      expect(gated.started).toEqual([]);
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          flows: {
            "demo/review": { items: [item("pr-1", { assignees: ["alice"] })] },
            "demo/gated": { items: [item("pr-1")], gate: "usage gate: over the ceiling" },
          },
        }),
      ),
    ),
  );

  effect("a person running the flow now skips the gates, and finds the item they name", () =>
    Effect.gen(function* () {
      const outcome = yield* tickFlowUseCase(review, {
        ...open,
        gates: false,
        item: Option.some("issue-7"),
        conditions: { ...open.conditions, paused: true },
      });

      expect(outcome.started.map((found) => found.itemKey)).toEqual(["issue-7"]);
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          flows: { "demo/review": { items: [], findable: [item("issue-7")] } },
        }),
      ),
    ),
  );
});
