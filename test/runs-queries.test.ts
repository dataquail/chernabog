import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BUNDLED_CORE_VERSION } from "../src/kernel/core-support.value-object.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { HoldsRoot } from "../src/modules/runs/domain/holds/holds.root.ts";
import { RunRoot } from "../src/modules/runs/domain/run/run.root.ts";
import { RunStepEntity } from "../src/modules/runs/domain/run/run-step.entity.ts";
import { RunMarkerRootOps } from "../src/modules/runs/domain/run-marker/run-marker.root-ops.ts";
import { RunWaitRoot } from "../src/modules/runs/domain/run-wait/run-wait.root.ts";
import { SkipRoot } from "../src/modules/runs/domain/skip/skip.root.ts";
import { HoldsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/holds.repository-fake.ts";
import { RunMarkersRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-markers.repository-fake.ts";
import { RunStepsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-steps.repository-fake.ts";
import { RunWaitsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/runs.repository-fake.ts";
import { SkipsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/skips.repository-fake.ts";
import { RunsQueries, RunsQueriesLive } from "../src/modules/runs/runs.query-handlers.ts";
import { effect } from "./effect-test.ts";
import { sqliteAfter } from "./sqlite.ts";

const AT = "2026-10-20T00:00:00.000Z";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: BUNDLED_CORE_VERSION,
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: AT,
    finishedAt: Option.none(),
    ...fields,
  });

const ended = run("ended", { status: "done", finishedAt: Option.some(AT) });

// The runs' stores in state.db, as the daemon provides them beneath RunsQueries.
const stores = Layer.mergeAll(
  // The SQL client ReadStateVersionQuery asks state.db through.
  sqliteAfter(Effect.void),
  RunsRepositoryFake([run("a"), run("old", { coreVersion: "0.5.2" }), ended]),
  RunMarkersRepositoryFake([
    RunMarkerRootOps.hold({ runId: RunId.make("a"), name: "label", args: 1, keepOn: [] }, AT),
    RunMarkerRootOps.hold({ runId: ended.id, name: "label", args: 2, keepOn: [] }, AT),
  ]),
  RunStepsRepositoryFake([
    RunStepEntity.make({ runId: RunId.make("a"), step: "claim", enteredAt: AT }),
  ]),
  RunWaitsRepositoryFake([
    RunWaitRoot.make({
      runId: RunId.make("a"),
      signal: "pushed",
      deferred: "d1",
      token: "t",
      parkedAt: Option.none(),
    }),
  ]),
  SkipsRepositoryFake([
    SkipRoot.make({
      repo: "demo",
      persona: Option.none(),
      flow: "review",
      itemKey: Option.none(),
      reason: "paused",
      at: AT,
    }),
  ]),
  HoldsRepositoryFake([
    HoldsRoot.make({
      repo: "demo",
      persona: Option.some("bob"),
      flow: "implement",
      items: [{ itemKey: "issue-14", reason: "waits on #12" }],
      at: AT,
    }),
  ]),
);

describe("RunsQueries", () => {
  effect("answers each of the runs' queries from the stores in state.db", () =>
    Effect.gen(function* () {
      const runs = yield* RunsQueries;
      const a = RunId.make("a");

      expect(Option.isSome((yield* runs.FindRunQuery({ runId: a })).run)).toBe(true);
      expect(
        (yield* runs.ListActiveRunsQuery({
          repo: Option.none(),
          persona: Option.none(),
          flow: Option.none(),
        })).runs.map((found) => String(found.id)),
      ).toEqual(["a", "old"]);
      expect((yield* runs.ListRecentRunsQuery({ latest: 10 })).runs).toHaveLength(3);
      expect((yield* runs.ListRecentSkipsQuery({ latest: 10 })).skips).toHaveLength(1);
      expect((yield* runs.ListHoldsQuery()).holds.map((hold) => hold.itemKey)).toEqual([
        "issue-14",
      ]);
      expect(
        (yield* runs.ListRunMarkersQuery({ runId: a, name: Option.none() })).markers.map(
          (marker) => marker.args,
        ),
      ).toEqual([1]);
      expect(
        (yield* runs.ListRunWaitsQuery({ runId: a, signal: "pushed" })).waits.map(
          (wait) => wait.deferred,
        ),
      ).toEqual(["d1"]);
      expect(
        (yield* runs.ListUnreleasedMarkersQuery()).markers.map((marker) => String(marker.runId)),
      ).toEqual(["ended"]);
      expect(
        (yield* runs.ListUnsupportedRunsQuery()).runs.map(({ run: found }) => String(found.id)),
      ).toEqual(["old"]);
      expect(
        (yield* runs.ReadRunHistoryQuery({ runId: a })).steps.map((found) => found.step),
      ).toEqual(["claim"]);
    }).pipe(Effect.provide(RunsQueriesLive.pipe(Layer.provide(stores)))),
  );
});
