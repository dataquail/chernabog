import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
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
import { deliverSignalsHandler } from "./deliver-signals.handler.ts";

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
    FlowsClientFake(stored.flows ?? {}),
    WorkflowsClientFake(engine),
  );

const wait = (signal: string, deferred: string) =>
  RunWaitRoot.make({
    runId: RunId.make("a"),
    signal,
    deferred,
    token: "t",
    parkedAt: Option.none(),
  });

describe("deliverSignalsHandler", () => {
  const engine = fakeEngine();

  effect("wakes the item's run on each signal it waits on, once", () =>
    Effect.gen(function* () {
      const first = yield* deliverSignalsHandler({
        flow: review,
        items: [item("pr-1", { signals: ["pushed"] })],
      });

      const again = yield* deliverSignalsHandler({
        flow: review,
        items: [item("pr-1", { signals: ["pushed"] })],
      });

      expect([first.count, again.count]).toEqual([1, 0]);
      expect(engine.woken).toEqual(["d1"]);
      expect(engine.notes).toEqual(["a: signal: pushed"]);
    }).pipe(
      Effect.provide([
        runtime(engine, {
          runs: [run("a")],
          waits: [wait("pushed", "d1"), wait("approved", "d2")],
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  const racing = fakeEngine();

  effect("a signal that wins a race of several clears the others in it, and wakes no loser", () =>
    Effect.gen(function* () {
      const delivered = yield* deliverSignalsHandler({
        flow: review,
        items: [item("pr-1", { signals: ["approved", "changes-requested"] })],
      });

      expect(delivered.count).toBe(1);
      expect(racing.woken).toEqual(["approved:plan-1"]);
      expect(
        (yield* (yield* RunWaitsRepository).findAll(Option.none())).map((left) => left.deferred),
      ).toEqual(["pushed:ci-1"]);
    }).pipe(
      Effect.provide([
        runtime(racing, {
          runs: [run("a")],
          waits: [
            wait("approved", "approved:plan-1"),
            wait("changes-requested", "changes-requested:plan-1"),
            wait("pushed", "pushed:ci-1"),
          ],
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );
});
