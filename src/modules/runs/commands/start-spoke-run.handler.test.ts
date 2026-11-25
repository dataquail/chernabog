import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
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
import { startSpokeRunHandler } from "./start-spoke-run.handler.ts";

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
    RecordedEvents,
    RunsRepositoryFake(stored.runs ?? []),
    RunWaitsRepositoryFake(stored.waits ?? []),
    SkipsRepositoryFake([]),
    FlowsClientFake(stored.flows ?? {}),
    WorkflowsClientFake(engine),
  );

describe("startSpokeRunHandler", () => {
  const engine = fakeEngine();

  effect("records a run with its execution attached, and executes nothing", () =>
    Effect.gen(function* () {
      const started = yield* startSpokeRunHandler({
        flow: review,
        item: item("pr-2", { title: "Fix it" }),
      });

      const recorded = Option.getOrThrow(started.run);

      expect([started.started, recorded.itemKey, recorded.itemTitle, recorded.status]).toEqual([
        true,
        "pr-2",
        Option.some("Fix it"),
        "running",
      ]);
      expect(recorded.executionId).toEqual(Option.some(`execution-${recorded.id}`));
      expect(engine.executed).toEqual([]);
      expect(engine.journals).toEqual([]);
      expect((yield* DispatchedEvents).map((event) => [event._tag, event.eventId])).toEqual([
        ["RunStarted", `${recorded.id}:started`],
      ]);
    }).pipe(Effect.provide(runtime(engine))),
  );

  const busy = fakeEngine();

  effect("is the run already in flight for the item, and starts none for a wake-only item", () =>
    Effect.gen(function* () {
      const again = yield* startSpokeRunHandler({ flow: review, item: item("pr-1") });

      const waking = yield* startSpokeRunHandler({
        flow: review,
        item: item("pr-3", { wakeOnly: true }),
      });

      expect([again.started, Option.map(again.run, (found) => String(found.id))]).toEqual([
        false,
        Option.some("a"),
      ]);
      expect([waking.started, waking.run]).toEqual([false, Option.none()]);
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(Effect.provide(runtime(busy, { runs: [run("a")] }))),
  );

  const holding = fakeEngine();

  effect("starts no run for a held item, and starts the one beside it", () =>
    Effect.gen(function* () {
      const held = yield* startSpokeRunHandler({
        flow: review,
        item: item("pr-4", { held: "waits on #3" }),
      });

      const beside = yield* startSpokeRunHandler({ flow: review, item: item("pr-6") });

      expect([held.started, held.run]).toEqual([false, Option.none()]);
      expect(beside.started).toBe(true);
    }).pipe(Effect.provide(runtime(holding))),
  );
});
