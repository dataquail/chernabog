import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { type LabelledContainer } from "../domain/ports/clients/run-cleanup.client.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import {
  type FakeHoldings,
  fakeHoldings,
  RunCleanupClientFake,
} from "../infrastructure/clients/run-cleanup.client-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { sweepContainersHandler } from "./sweep-containers.handler.ts";

const run = (id: string, status: RunRoot["status"]) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.none(),
    flow: "implement",
    itemKey: "issue-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status,
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-11-26T00:00:00.000Z",
    finishedAt: Option.none(),
  });

const container = (
  id: string,
  runId: string,
  fields: Partial<LabelledContainer> = {},
): LabelledContainer => ({
  runtime: "docker",
  id,
  runId,
  sessionId: Option.some(`session-${id}`),
  launched: false,
  ...fields,
});

const runtime = (holdings: FakeHoldings) =>
  Layer.mergeAll(
    RecordedEvents,
    RunsRepositoryFake([run("live", "running"), run("ended", "cancelled")]),
    RunCleanupClientFake(holdings),
  );

// ADR 24, decision 9: the sweep removes any labelled container whose run has ended.
describe("sweepContainersHandler", () => {
  const held = fakeHoldings({
    containers: [
      // A run that ended, whose session's shim died: nothing else removes it.
      container("orphan", "ended"),
      // A run state.db has never heard of has no run in flight either.
      container("unknown", "gone", { runtime: "podman", sessionId: Option.none() }),
      // A run still in flight keeps its container, whether its shim lives or not.
      container("in-flight", "live"),
      // A session whose __launch still runs removes its own as it exits, as a
      // person's session that cancel left open does.
      container("launched", "ended", { launched: true }),
    ],
  });

  effect("removes the containers of runs that have ended whose __launch is gone", () =>
    Effect.gen(function* () {
      const swept = yield* sweepContainersHandler();

      expect(swept.removed).toEqual([
        { runtime: "docker", id: "orphan", runId: "ended" },
        { runtime: "podman", id: "unknown", runId: "gone" },
      ]);
      expect(swept.failed).toEqual([]);
      expect(held.containers.map((left) => left.id)).toEqual(["in-flight", "launched"]);
    }).pipe(Effect.provide(runtime(held))),
  );

  const downHeld = fakeHoldings({
    containers: [container("orphan", "ended")],
    failingRuntimes: { podman: "`podman ps` failed: Cannot connect to Podman" },
  });

  effect("a runtime that doesn't answer keeps none of the others from their sweep", () =>
    Effect.gen(function* () {
      const swept = yield* sweepContainersHandler();

      expect(swept.removed).toEqual([{ runtime: "docker", id: "orphan", runId: "ended" }]);
      expect(swept.failed).toEqual([
        { runtime: "podman", message: "`podman ps` failed: Cannot connect to Podman" },
      ]);
    }).pipe(Effect.provide(runtime(downHeld))),
  );
});
