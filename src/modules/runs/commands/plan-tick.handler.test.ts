import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
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
import { listHoldsHandler } from "../queries/list-holds.handler.ts";
import { listRecentSkipsHandler } from "../queries/list-recent-skips.handler.ts";
import { type PlanTickPayload } from "./plan-tick.command.ts";
import { planTickHandler } from "./plan-tick.handler.ts";

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

const open: Omit<PlanTickPayload, "flow"> = {
  gates: true,
  item: Option.none(),
  conditions: {
    enabled: true,
    flowOff: Option.none(),
    paused: false,
    quietHours: Option.none(),
    activeHours: Option.none(),
  },
  concurrency: { flow: 1, machine: 4 },
};

const reasons = listRecentSkipsHandler({ latest: 5 }).pipe(
  Effect.map(({ skips }) => skips.map((skip) => skip.reason)),
);

const planning = (flow: PlanTickPayload["flow"], input: Omit<PlanTickPayload, "flow">) =>
  planTickHandler({ flow, ...input });

const keys = (items: ReadonlyArray<WorkItem>) => items.map((found) => found.key);

describe("planTickHandler", () => {
  effect(
    "lists the items its trigger says wait on someone, with who and why, whatever the flow's name, and starts none of them",
    () =>
      Effect.gen(function* () {
        const reviewing = { ...review, flow: "pr-reviews" };
        const plan = yield* planning(reviewing, open);
        const named = yield* planning(reviewing, { ...open, item: Option.some("pr-73") });

        expect(plan.routed).toEqual(
          Option.some({
            queued: ["pr-74"],
            elsewhere: [],
            waiting: ["pr-73 waits on data-quail (not on this machine)"],
          }),
        );
        expect(keys(plan.start)).toEqual(["pr-74"]);
        expect(keys(plan.signalled)).toEqual(["pr-73", "pr-74"]);
        expect(named.start).toEqual([]);
      }).pipe(
        Effect.provide([
          runtime(fakeEngine(), {
            flows: {
              "demo/pr-reviews": {
                items: [
                  item("pr-73", {
                    waitsOn: { who: "data-quail", why: "not on this machine" },
                  }),
                  item("pr-74"),
                ],
              },
            },
          }),
          PassThroughUnitOfWork,
        ]),
      ),
  );

  effect("starts runs for the work its trigger finds, up to the flow's limit", () =>
    Effect.gen(function* () {
      const plan = yield* planning(review, open);

      expect(keys(plan.start)).toEqual(["pr-1"]);
      expect(keys(plan.signalled)).toEqual(["pr-1", "pr-2"]);
      expect(plan.routed).toEqual(
        Option.some({ queued: ["pr-1 One", "pr-2"], elsewhere: [], waiting: [] }),
      );
      expect(plan.skipped).toEqual(Option.none());
    }).pipe(
      Effect.provide([
        runtime(fakeEngine(), {
          flows: { "demo/review": { items: [item("pr-1", { title: "One" }), item("pr-2")] } },
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect(
    "records why it starts nothing: the machine's gates, a failing trigger, a persona not ready, the limit",
    () =>
      Effect.gen(function* () {
        const paused = yield* planning(review, {
          ...open,
          conditions: { ...open.conditions, paused: true },
        });

        yield* planning({ ...review, flow: "broken" }, open);
        yield* planning({ ...review, flow: "logged-out" }, open);
        const limited = yield* planning(review, open);

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
        Effect.provide([
          runtime(fakeEngine(), {
            runs: [run("busy", { itemKey: "pr-9" })],
            flows: {
              "demo/review": { items: [item("pr-1")] },
              "demo/broken": { items: [], fails: "rate limited" },
              "demo/logged-out": { items: [], notReady: "bob is unavailable; run gh auth login" },
            },
          }),
          PassThroughUnitOfWork,
        ]),
      ),
  );

  effect("doesn't count a run parked on a signal against the limits", () =>
    Effect.gen(function* () {
      const plan = yield* planning(review, open);

      expect(keys(plan.start)).toEqual(["pr-1"]);
    }).pipe(
      Effect.provide([
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
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("leaves work for others to them, and no work already running", () =>
    Effect.gen(function* () {
      const plan = yield* planning(review, open);

      expect(plan.skipped).toEqual(Option.some("only work for others: pr-1 (label: team-b)"));
      expect(plan.routed).toEqual(
        Option.some({ queued: [], elsewhere: ["pr-1 (label: team-b)"], waiting: [] }),
      );
      expect(plan.start).toEqual([]);
      expect(keys((yield* planning({ ...review, flow: "busy" }, open)).start)).toEqual([]);

      // A person who names it runs it here, whoever the flow left it for.
      const named = yield* planning(review, { ...open, item: Option.some("pr-1") });
      expect(keys(named.start)).toEqual(["pr-1"]);
    }).pipe(
      Effect.provide([
        runtime(fakeEngine(), {
          runs: [run("busy", { flow: "busy" })],
          flows: {
            "demo/review": { items: [item("pr-1", { elsewhere: "label: team-b" })] },
            "demo/busy": { items: [item("pr-1")] },
          },
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("a person running the flow now skips the gates, and finds the item they name", () =>
    Effect.gen(function* () {
      const plan = yield* planning(review, {
        ...open,
        gates: false,
        item: Option.some("issue-7"),
        conditions: { ...open.conditions, paused: true },
      });

      expect(keys(plan.start)).toEqual(["issue-7"]);
    }).pipe(
      Effect.provide([
        runtime(fakeEngine(), {
          flows: { "demo/review": { items: [], findable: [item("issue-7")] } },
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect(
    "never starts a held item, though its signals still go out, and records why it's held",
    () =>
      Effect.gen(function* () {
        const implement = { ...review, flow: "implement" };
        const plan = yield* planning(implement, open);

        expect(keys(plan.start)).toEqual(["issue-15"]);
        expect(keys(plan.signalled)).toEqual(["issue-14", "issue-15", "issue-16"]);
        expect(plan.routed).toEqual(
          Option.some({ queued: ["issue-15"], elsewhere: [], waiting: [] }),
        );

        expect(
          (yield* listHoldsHandler()).holds.map((hold) => [hold.flow, hold.itemKey, hold.reason]),
        ).toEqual([
          ["implement", "issue-14", "waits on #12, #13"],
          ["implement", "issue-16", "waits on #15"],
        ]);

        // Not even a person naming it starts it, and they hear why.
        const named = yield* planning(implement, {
          ...open,
          gates: false,
          item: Option.some("issue-14"),
        });

        expect(named.start).toEqual([]);
        expect(named.skipped).toEqual(Option.some("issue-14 is held: waits on #12, #13"));
      }).pipe(
        Effect.provide([
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
          PassThroughUnitOfWork,
        ]),
      ),
  );

  effect("a tick's holds replace the flow's last, and leave other flows' alone", () =>
    Effect.gen(function* () {
      const implement = { ...review, flow: "implement" };
      yield* planning(review, open);
      yield* planning(implement, open);
      yield* planning({ ...implement, repo: "next" }, open);

      expect(
        (yield* listHoldsHandler()).holds.map(
          (hold) => `${hold.repo}/${hold.flow} ${hold.itemKey}`,
        ),
      ).toEqual(["demo/review pr-1"]);
    }).pipe(
      Effect.provide([
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
        PassThroughUnitOfWork,
      ]),
    ),
  );
});
