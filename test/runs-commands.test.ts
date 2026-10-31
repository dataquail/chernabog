import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BUNDLED_CORE_VERSION } from "../src/kernel/core-support.value-object.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { RunLogsClientFake } from "../src/modules/runs/infrastructure/clients/run-logs.client-fake.ts";
import { HoldsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/holds.repository-fake.ts";
import { RunMarkersRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-markers.repository-fake.ts";
import { RunStepsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-steps.repository-fake.ts";
import { RunWaitsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/runs.repository-fake.ts";
import { SkipsRepositoryFake } from "../src/modules/runs/infrastructure/repositories/skips.repository-fake.ts";
import { RunsCommands, RunsCommandsLive } from "../src/modules/runs/runs.command-handlers.ts";
import { RunsQueries, RunsQueriesLive } from "../src/modules/runs/runs.query-handlers.ts";
import { effect } from "./effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "./events.ts";

// The runs' stores in state.db, their logs, and the bus their commands
// dispatch on, as the engine provides them beneath RunsCommands and RunsQueries.
const stores = Layer.mergeAll(
  RecordedEvents,
  RunLogsClientFake({}),
  RunsRepositoryFake([]),
  RunMarkersRepositoryFake([]),
  RunStepsRepositoryFake([]),
  RunWaitsRepositoryFake([]),
  SkipsRepositoryFake([]),
  HoldsRepositoryFake([]),
);

describe("RunsCommands", () => {
  effect("starts, steps, parks, releases and finishes a run in the stores in state.db", () =>
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

      const released = yield* commands.ReleaseRunWaitCommand({ wait: parked });

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
      expect(released.deferred).toBe("d1");
      expect((yield* queries.ListRunWaitsQuery({ runId, signal: "pushed" })).waits).toEqual([]);
      expect([finished.status, finished.summary]).toEqual(["done", Option.some("approved")]);
      expect(Option.map((yield* queries.FindRunQuery({ runId })).run, (run) => run.status)).toEqual(
        Option.some("done"),
      );
      expect(
        (yield* queries.ReadRunHistoryQuery({ runId })).steps.map((found) => found.step),
      ).toEqual(["review"]);
      expect((yield* DispatchedEvents).map((event) => [event._tag, event.eventId])).toEqual([
        ["RunStarted", "a:started"],
        ["RunEnteredStep", "a:step:review"],
        ["RunNeedsAttention", "a:park:d1"],
        ["RunFinished", "a:finished"],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunsCommandsLive, RunsQueriesLive).pipe(Layer.provideMerge(stores)),
      ),
    ),
  );

  effect("attaches a run's execution and adopts a repo's runs from before its personas", () =>
    Effect.gen(function* () {
      const commands = yield* RunsCommands;
      const queries = yield* RunsQueries;
      const runId = RunId.make("old");

      yield* commands.StartRunCommand({
        id: runId,
        coreVersion: BUNDLED_CORE_VERSION,
        repo: "demo",
        persona: Option.none(),
        flow: "review",
        itemKey: "pr-1",
        itemTitle: Option.none(),
        itemUrl: Option.none(),
        item: Option.none(),
      });

      const attached = yield* commands.AttachExecutionCommand({ runId, executionId: "x" });
      const adopted = yield* commands.AdoptImplicitRunsCommand({ repo: "demo", login: "alice" });

      expect(attached.executionId).toEqual(Option.some("x"));
      expect(adopted.runs).toEqual([runId]);
      expect(
        Option.map((yield* queries.FindRunQuery({ runId })).run, (run) => run.persona),
      ).toEqual(Option.some(Option.some("alice")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunsCommandsLive, RunsQueriesLive).pipe(Layer.provideMerge(stores)),
      ),
    ),
  );
  effect("holds and forgets a run's markers, names its subjects and records a skip", () =>
    Effect.gen(function* () {
      const commands = yield* RunsCommands;
      const queries = yield* RunsQueries;
      const runId = RunId.make("a");

      yield* commands.StartRunCommand({
        id: runId,
        coreVersion: BUNDLED_CORE_VERSION,
        repo: "demo",
        persona: Option.some("bob"),
        flow: "implement",
        itemKey: "issue-1",
        itemTitle: Option.none(),
        itemUrl: Option.none(),
        item: Option.none(),
      });

      const label = { runId, name: "chernabog/label", keepOn: [] };
      const held = yield* commands.HoldMarkerCommand({ ...label, args: { number: 1 } });
      yield* commands.HoldMarkerCommand({ ...label, args: { number: 2 } });
      yield* commands.ForgetMarkerCommand({ runId, name: label.name, args: { number: 1 } });

      const named = yield* commands.NameSubjectCommand({ runId, subject: "pr-2" });

      const skipped = yield* commands.RecordSkipCommand({
        repo: "demo",
        persona: Option.some("bob"),
        flow: "implement",
        itemKey: Option.none(),
        reason: "paused",
      });

      expect(held.status).toBe("held");
      expect(
        (yield* queries.ListRunMarkersQuery({ runId, name: Option.none() })).markers.map(
          (marker) => marker.args,
        ),
      ).toEqual([{ number: 2 }]);
      expect(named.subjects).toEqual(["pr-2"]);
      expect((yield* queries.ListRecentSkipsQuery({ latest: 5 })).skips).toEqual([skipped]);
      expect(
        (yield* Effect.flip(
          commands.NameSubjectCommand({ runId: RunId.make("gone"), subject: "pr-2" }),
        ))._tag,
      ).toBe("RunNotFound");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunsCommandsLive, RunsQueriesLive).pipe(Layer.provideMerge(stores)),
      ),
    ),
  );
});
