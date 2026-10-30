import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BUNDLED_CORE_VERSION } from "../src/kernel/core-support.value-object.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { HoldsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/holds.repository-fake.ts";
import { RunMarkersRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-markers.repository-fake.ts";
import { RunStepsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-steps.repository-fake.ts";
import { RunWaitsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/runs.repository-fake.ts";
import { SkipsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/skips.repository-fake.ts";
import { RunsCommands, RunsCommandsLive } from "../src/modules/runs/runs.command-handlers.ts";
import { RunsQueries, RunsQueriesLive } from "../src/modules/runs/runs.query-handlers.ts";
import { effect } from "./effect-test.ts";

// The runs' stores in state.db, as the engine provides them beneath RunsCommands
// and RunsQueries.
const stores = Layer.mergeAll(
  RunsRepositoryFake([]),
  RunMarkersRepositoryFake([]),
  RunStepsRepositoryFake([]),
  RunWaitsRepositoryFake([]),
  SkipsRepositoryFake([]),
  HoldsRepositoryFake([]),
);

describe("RunsCommands", () => {
  effect("starts, steps, parks and finishes a run in the stores in state.db", () =>
    Effect.gen(function* () {
      const commands = yield* RunsCommands;
      const queries = yield* RunsQueries;
      const runId = RunId.make("a");

      const started = yield* commands.StartRunCommand({
        id: runId,
        coreVersion: BUNDLED_CORE_VERSION,
        repo: "demo",
        persona: Option.some("bob"),
        flow: "review",
        itemKey: "pr-1",
        itemTitle: Option.none(),
        itemUrl: Option.none(),
        item: Option.none(),
      });

      const stepped = yield* commands.EnterStepCommand({ runId, step: "review" });

      const parked = yield* commands.ParkRunCommand({
        runId,
        signal: "pushed",
        deferred: "d1",
        token: "t",
      });

      const finished = yield* commands.FinishRunCommand({
        runId,
        status: "done",
        summary: "approved",
      });

      expect([started.status, stepped.currentStep, parked.signal]).toEqual([
        "running",
        Option.some("review"),
        "pushed",
      ]);
      expect([finished.status, finished.summary]).toEqual(["done", Option.some("approved")]);
      expect(Option.map((yield* queries.FindRunQuery({ runId })).run, (run) => run.status)).toEqual(
        Option.some("done"),
      );
      expect(
        (yield* queries.ReadRunHistoryQuery({ runId })).steps.map((found) => found.step),
      ).toEqual(["review"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunsCommandsLive, RunsQueriesLive).pipe(Layer.provideMerge(stores)),
      ),
    ),
  );
});
