import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { RunLane, RunStep } from "../domain/run/run-history.value-object.ts";
import { RunLaneEntity } from "../domain/run/run-lane.entity.ts";
import { RunLanesRepository } from "../domain/run/run-lanes.repository.ts";
import { RunStepEntity } from "../domain/run/run-step.entity.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { RunLogsClientLive } from "../infrastructure/clients/run-logs.client-live.ts";
import { RunLanesRepositoryLive } from "../infrastructure/repositories/run-lanes.repository-live.ts";
import { RunStepsRepositoryLive } from "../infrastructure/repositories/run-steps.repository-live.ts";
import { RunWaitsRepositoryLive } from "../infrastructure/repositories/run-waits.repository-live.ts";
import { readRunHistoryHandler } from "./read-run-history.handler.ts";

const a = RunId.make("a");

const T = "2026-10-20T00:00:00.000Z";

const step = (runId: RunId, name: string, enteredAt: string) =>
  RunStepEntity.make({
    runId,
    step: name,
    enteredAt,
    finishedAt: Option.none(),
    outcome: Option.none(),
  });

// Writes a run's log in the scratch home's runs folder, as the engine does.
const writeLog = (runId: RunId, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths((yield* Home).root);
    yield* fs.makeDirectory(paths.runs, { recursive: true });
    yield* fs.writeFileString(paths.runLog(runId), text);
  });

const stores = Layer.mergeAll(
  RunStepsRepositoryLive,
  RunWaitsRepositoryLive,
  RunLanesRepositoryLive,
).pipe(Layer.provide(sqliteAfter(Effect.void)), Layer.merge(RunLogsClientLive));

describe("readRunHistoryHandler", () => {
  effectAtHome("reads a run's steps in order, how each ended, and the signals it's parked on", () =>
    Effect.gen(function* () {
      const steps = yield* RunStepsRepository;
      yield* steps.insertOne(step(a, "claim", T));
      yield* steps.insertOne(step(RunId.make("b"), "claim", "2026-10-20T00:00:30.000Z"));
      yield* steps.insertOne(step(a, "wait-for-push", "2026-10-20T00:01:00.000Z"));
      yield* steps.updateOne(
        RunStepEntity.make({
          ...step(a, "claim", T),
          finishedAt: Option.some("2026-10-20T00:00:10.000Z"),
          outcome: Option.some("ok"),
        }),
      );
      yield* (yield* RunWaitsRepository).upsertOne(
        RunWaitRoot.make({
          runId: a,
          signal: "pushed",
          deferred: "d",
          token: "t",
          parkedAt: Option.some("2026-10-20T00:02:00.000Z"),
        }),
      );

      const history = yield* readRunHistoryHandler({ runId: a });

      expect(history.steps).toEqual([
        RunStep.make({
          step: "claim",
          enteredAt: T,
          finishedAt: "2026-10-20T00:00:10.000Z",
          outcome: "ok",
        }),
        RunStep.make({ step: "wait-for-push", enteredAt: "2026-10-20T00:01:00.000Z" }),
      ]);
      expect(history.waits.map((wait) => [wait.signal, wait.parkedAt])).toEqual([
        ["pushed", Option.some("2026-10-20T00:02:00.000Z")],
      ]);
      expect(yield* readRunHistoryHandler({ runId: RunId.make("old") })).toMatchObject({
        steps: [],
        waits: [],
        lanes: [],
      });
    }).pipe(Effect.provide(stores)),
  );

  effectAtHome("reads the lanes a run declared, and how its log splits by step", () =>
    Effect.gen(function* () {
      const lanes = yield* RunLanesRepository;
      const old = RunId.make("old");
      const laned = RunId.make("laned");
      yield* lanes.upsertOne(RunLaneEntity.make({ runId: a, lane: "task-2", needs: ["task-1"] }));
      yield* lanes.upsertOne(RunLaneEntity.make({ runId: laned, lane: "task-1", needs: [] }));
      yield* writeLog(a, `${RunLogLines.entry(T, Option.some("claim"), "step: claim")}\n`);
      yield* writeLog(old, `${T} step: claim\n`);
      yield* writeLog(laned, `${T} step: claim\n`);

      const history = yield* readRunHistoryHandler({ runId: a });

      expect(history.lanes).toEqual([RunLane.make({ lane: "task-2", needs: ["task-1"] })]);
      expect(history.stepLogs).toBe("tagged");
      expect((yield* readRunHistoryHandler({ runId: old })).stepLogs).toBe("inferred");
      expect((yield* readRunHistoryHandler({ runId: laned })).stepLogs).toBe("unavailable");
      expect((yield* readRunHistoryHandler({ runId: RunId.make("new") })).stepLogs).toBe("tagged");
    }).pipe(Effect.provide(stores)),
  );
});
