import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { type WorkItem } from "../domain/run/work-item.value-object.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
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
import { planTickUseCase, type TickInput } from "./plan-tick.use-case.ts";

const review = { repo: "demo", flow: "review", persona: Option.some("bob") };

const item = (key: string, fields: Partial<WorkItem> = {}): WorkItem => ({
  key,
  data: {},
  ...fields,
});

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
  here: ["bob"],
  concurrency: { flow: 1, machine: 4 },
};

const reasons = listRecentSkipsUseCase(5).pipe(
  Effect.map(({ skips }) => skips.map((skip) => skip.reason)),
);

const keys = (items: ReadonlyArray<WorkItem>) => items.map((found) => found.key);

describe("planTickUseCase", () => {
  effect(
    "lists the review requests no persona here serves, for the review flow only, even when its trigger fails",
    () =>
      Effect.gen(function* () {
        const reviewing = yield* planTickUseCase(review, open);
        const failing = yield* planTickUseCase({ ...review, repo: "other" }, open);
        const implementing = yield* planTickUseCase({ ...review, flow: "implement" }, open);

        const paused = yield* planTickUseCase(review, {
          ...open,
          conditions: { ...open.conditions, paused: true },
        });

        expect(reviewing.unserved).toEqual(
          Option.some(["#73 waits on data-quail (not on this machine)"]),
        );
        expect(failing.skipped).toEqual(Option.some("trigger failed: rate limited"));
        expect(failing.unserved).toEqual(Option.some(["#9 waits on carol (not on this machine)"]));
        expect(implementing.unserved).toEqual(Option.none());
        expect(paused.unserved).toEqual(Option.none());
      }).pipe(
        Effect.provide(
          runtime(fakeEngine(), {
            flows: {
              "demo/review": {
                items: [],
                reviewRequests: [
                  { number: 73, requestedReviewers: ["data-quail"] },
                  { number: 74, requestedReviewers: ["Bob"] },
                ],
              },
              "other/review": {
                items: [],
                fails: "rate limited",
                reviewRequests: [{ number: 9, requestedReviewers: ["carol"] }],
              },
              "demo/implement": {
                items: [],
                reviewRequests: [{ number: 9, requestedReviewers: ["carol"] }],
              },
            },
          }),
        ),
      ),
  );

  effect("starts runs for the work its trigger finds, up to the flow's limit", () =>
    Effect.gen(function* () {
      const plan = yield* planTickUseCase(review, open);

      expect(keys(plan.start)).toEqual(["pr-1"]);
      expect(keys(plan.signalled)).toEqual(["pr-1", "pr-2"]);
      expect(plan.routed).toEqual(Option.some({ queued: ["pr-1 One", "pr-2"], elsewhere: [] }));
      expect(plan.skipped).toEqual(Option.none());
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          flows: { "demo/review": { items: [item("pr-1", { title: "One" }), item("pr-2")] } },
        }),
      ),
    ),
  );

  effect(
    "records why it starts nothing: the machine's gates, a failing trigger, a persona not ready, the limit",
    () =>
      Effect.gen(function* () {
        const paused = yield* planTickUseCase(review, {
          ...open,
          conditions: { ...open.conditions, paused: true },
        });

        yield* planTickUseCase({ ...review, flow: "broken" }, open);
        yield* planTickUseCase({ ...review, flow: "logged-out" }, open);
        const limited = yield* planTickUseCase(review, open);

        expect(paused.signalled).toEqual([]);
        expect(limited.start).toEqual([]);
        expect(keys(limited.signalled)).toEqual(["pr-1"]);
        expect(yield* reasons).toContain("paused");
        expect(yield* reasons).toContain("trigger failed: rate limited");
        expect(yield* reasons).toContain("bob is unavailable; run gh auth login");
        expect(
          (yield* reasons).some((reason) => reason.startsWith("at the concurrency limit")),
        ).toBe(true);
      }).pipe(
        Effect.provide(
          runtime(fakeEngine(), {
            runs: [run("busy", { itemKey: "pr-9" })],
            flows: {
              "demo/review": { items: [item("pr-1")] },
              "demo/broken": { items: [], fails: "rate limited" },
              "demo/logged-out": { items: [], notReady: "bob is unavailable; run gh auth login" },
            },
          }),
        ),
      ),
  );

  effect("doesn't count a run parked on a signal against the limits", () =>
    Effect.gen(function* () {
      const plan = yield* planTickUseCase(review, open);

      expect(keys(plan.start)).toEqual(["pr-1"]);
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          runs: [run("parked", { itemKey: "pr-9" })],
          waits: [
            RunWaitRoot.make({
              runId: RunId.make("parked"),
              signal: "ci",
              deferred: "deferred",
              token: "token",
            }),
          ],
          flows: { "demo/review": { items: [item("pr-1")] } },
        }),
      ),
    ),
  );

  effect("leaves work for others to them, and no work already running", () =>
    Effect.gen(function* () {
      const plan = yield* planTickUseCase(review, {
        ...open,
        routing: { assignee: Option.some(["@me"]), reviewRequested: Option.none() },
      });

      expect(plan.skipped).toEqual(Option.some("only work for others: pr-1 (assignee: alice)"));
      expect(plan.start).toEqual([]);
      expect(keys((yield* planTickUseCase({ ...review, flow: "busy" }, open)).start)).toEqual([]);
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          runs: [run("busy", { flow: "busy" })],
          flows: {
            "demo/review": { items: [item("pr-1", { assignees: ["alice"] })] },
            "demo/busy": { items: [item("pr-1")] },
          },
        }),
      ),
    ),
  );

  effect("a person running the flow now skips the gates, and finds the item they name", () =>
    Effect.gen(function* () {
      const plan = yield* planTickUseCase(review, {
        ...open,
        gates: false,
        item: Option.some("issue-7"),
        conditions: { ...open.conditions, paused: true },
      });

      expect(keys(plan.start)).toEqual(["issue-7"]);
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          flows: { "demo/review": { items: [], findable: [item("issue-7")] } },
        }),
      ),
    ),
  );
});
