import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { HoldsRoot } from "../domain/holds/holds.root.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { type WorkItem } from "../domain/run/work-item.value-object.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { type FakeFlow, FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import {
  type FakeEngine,
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { HoldsRepositoryFake } from "../infrastructure/repositories/holds.repository-fake.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { SkipsRepositoryFake } from "../infrastructure/repositories/skips.repository-fake.ts";
import { listHoldsUseCase } from "./list-holds.use-case.ts";
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
    HoldsRepositoryFake([]),
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
              parkedAt: Option.none(),
            }),
          ],
          flows: { "demo/review": { items: [item("pr-1")] } },
        }),
      ),
    ),
  );

  effect("leaves work for others to them, and no work already running", () =>
    Effect.gen(function* () {
      const plan = yield* planTickUseCase(review, open);

      expect(plan.skipped).toEqual(Option.some("only work for others: pr-1 (label: team-b)"));
      expect(plan.routed).toEqual(Option.some({ queued: [], elsewhere: ["pr-1 (label: team-b)"] }));
      expect(plan.start).toEqual([]);
      expect(keys((yield* planTickUseCase({ ...review, flow: "busy" }, open)).start)).toEqual([]);

      // A person who names it runs it here, whoever the flow left it for.
      const named = yield* planTickUseCase(review, { ...open, item: Option.some("pr-1") });
      expect(keys(named.start)).toEqual(["pr-1"]);
    }).pipe(
      Effect.provide(
        runtime(fakeEngine(), {
          runs: [run("busy", { flow: "busy" })],
          flows: {
            "demo/review": { items: [item("pr-1", { elsewhere: "label: team-b" })] },
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

  effect(
    "never starts a held item, though its signals still go out, and records why it's held",
    () =>
      Effect.gen(function* () {
        const implement = { ...review, flow: "implement" };
        const plan = yield* planTickUseCase(implement, open);

        expect(keys(plan.start)).toEqual(["issue-15"]);
        expect(keys(plan.signalled)).toEqual(["issue-14", "issue-15", "issue-16"]);
        expect(plan.routed).toEqual(Option.some({ queued: ["issue-15"], elsewhere: [] }));

        expect(
          (yield* listHoldsUseCase()).holds.map((hold) => [hold.flow, hold.itemKey, hold.reason]),
        ).toEqual([
          ["implement", "issue-14", "waits on #12, #13"],
          ["implement", "issue-16", "waits on #15"],
        ]);

        // Not even a person naming it starts it, and they hear why.
        const named = yield* planTickUseCase(implement, {
          ...open,
          gates: false,
          item: Option.some("issue-14"),
        });

        expect(named.start).toEqual([]);
        expect(named.skipped).toEqual(Option.some("issue-14 is held: waits on #12, #13"));
      }).pipe(
        Effect.provide(
          runtime(fakeEngine(), {
            flows: {
              "demo/implement": {
                items: [
                  item("issue-14", { held: "waits on #12, #13" }),
                  item("issue-15"),
                  item("issue-16", { held: "waits on #15", wakeOnly: true, signals: ["ci"] }),
                ],
              },
            },
          }),
        ),
      ),
  );

  effect("a tick's holds replace the flow's last, and leave other flows' alone", () =>
    Effect.gen(function* () {
      const implement = { ...review, flow: "implement" };
      yield* planTickUseCase(review, open);
      yield* planTickUseCase(implement, open);
      yield* planTickUseCase({ ...implement, repo: "next" }, open);

      expect(
        (yield* listHoldsUseCase()).holds.map(
          (hold) => `${hold.repo}/${hold.flow} ${hold.itemKey}`,
        ),
      ).toEqual(["demo/review pr-1"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          RunsRepositoryFake([]),
          RunWaitsRepositoryFake([]),
          SkipsRepositoryFake([]),
          HoldsRepositoryFake([
            HoldsRoot.make({
              repo: "demo",
              persona: Option.some("bob"),
              flow: "implement",
              items: [{ itemKey: "issue-1", reason: "waits on #2" }],
              at: "2026-10-20T00:00:00.000Z",
            }),
          ]),
          FlowsClientFake({
            "demo/review": { items: [item("pr-1", { held: "a draft" })] },
            "demo/implement": { items: [] },
            "next/implement": { items: [] },
          }),
          WorkflowsClientFake(fakeEngine()),
        ),
      ),
    ),
  );
});
