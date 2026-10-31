import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunStepRoot } from "../domain/run-step/run-step.root.ts";
import { RunStepsRepository } from "../domain/run-step/run-steps.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { RunStepsRepositoryLive } from "../infrastructure/repositories/run-steps.repository-live.ts";
import { RunWaitsRepositoryLive } from "../infrastructure/repositories/run-waits.repository-live.ts";
import { readRunHistoryHandler } from "./read-run-history.handler.ts";

const a = RunId.make("a");

const step = (runId: RunId, name: string, enteredAt: string) =>
  RunStepRoot.make({ runId, step: name, enteredAt });

describe("readRunHistoryHandler", () => {
  effect("reads a run's steps in order, and the signals it's parked on", () =>
    Effect.gen(function* () {
      const steps = yield* RunStepsRepository;
      yield* steps.insertOne(step(a, "claim", "2026-10-20T00:00:00.000Z"));
      yield* steps.insertOne(step(RunId.make("b"), "claim", "2026-10-20T00:00:30.000Z"));
      yield* steps.insertOne(step(a, "wait-for-push", "2026-10-20T00:01:00.000Z"));
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

      expect(history.steps.map((found) => found.step)).toEqual(["claim", "wait-for-push"]);
      expect(history.waits.map((wait) => [wait.signal, wait.parkedAt])).toEqual([
        ["pushed", Option.some("2026-10-20T00:02:00.000Z")],
      ]);
      expect(yield* readRunHistoryHandler({ runId: RunId.make("old") })).toMatchObject({
        steps: [],
        waits: [],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunStepsRepositoryLive, RunWaitsRepositoryLive).pipe(
          Layer.provide(sqliteAfter(Effect.void)),
        ),
      ),
    ),
  );
});
