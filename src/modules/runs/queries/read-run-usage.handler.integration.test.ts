import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunStepEntity } from "../domain/run/run-step.entity.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { TokenUsageRoot } from "../domain/token-usage/token-usage.root.ts";
import { TokenUsagesRepository } from "../domain/token-usage/token-usages.repository.ts";
import { RunStepsRepositoryLive } from "../infrastructure/repositories/run-steps.repository-live.ts";
import { RunsRepositoryLive } from "../infrastructure/repositories/runs.repository-live.ts";
import { TokenUsagesRepositoryLive } from "../infrastructure/repositories/token-usages.repository-live.ts";
import { readRunUsageHandler } from "./read-run-usage.handler.ts";
import { TokenCounts } from "./read-run-usage.query.ts";

const a = RunId.make("a");
const at = (minute: number) => `2026-11-09T08:${String(minute).padStart(2, "0")}:00.000Z`;

const run = (id: RunId, finishedAt: Option.Option<string>) =>
  RunRoot.make({
    id,
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status: Option.match(finishedAt, { onNone: () => "running", onSome: () => "done" }),
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: at(0),
    finishedAt,
  });

const step = (runId: RunId, name: string, entered: number, finished: number) =>
  RunStepEntity.make({
    runId,
    step: name,
    node: Option.none(),
    enteredAt: at(entered),
    finishedAt: Option.some(at(finished)),
    outcome: Option.some("ok"),
  });

const spent = (
  runId: RunId,
  name: string,
  model: string,
  counts: { input: number; output: number; cacheRead: number; cacheWrite: number },
) =>
  TokenUsageRoot.make({
    runId,
    step: Option.some(name),
    adapter: "claude",
    sessionId: "s",
    model: Option.some(model),
    input: Option.some(counts.input),
    output: Option.some(counts.output),
    cacheRead: Option.some(counts.cacheRead),
    cacheWrite: Option.some(counts.cacheWrite),
    reported: true,
    recordedAt: at(1),
  });

const unreported = (runId: RunId, name: string) =>
  TokenUsageRoot.make({
    runId,
    step: Option.some(name),
    adapter: "custom",
    sessionId: "t",
    model: Option.none(),
    input: Option.none(),
    output: Option.none(),
    cacheRead: Option.none(),
    cacheWrite: Option.none(),
    reported: false,
    recordedAt: at(2),
  });

const stores = Layer.mergeAll(
  RunsRepositoryLive,
  RunStepsRepositoryLive,
  TokenUsagesRepositoryLive,
).pipe(Layer.provideMerge(sqliteAfter(Effect.void)));

const counts = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
  TokenCounts.make({
    total: input + output + cacheRead + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
  });

describe("readRunUsageHandler", () => {
  effect(
    "sums a run's tokens by model and by step, flags an unreported call, and unions its steps' time",
    () =>
      Effect.gen(function* () {
        yield* (yield* RunsRepository).upsertOne(run(a, Option.some(at(30))));

        const steps = yield* RunStepsRepository;
        // Two lanes overlapping by five minutes, then a gap while parked.
        yield* steps.insertOne(step(a, "implement", 0, 10));
        yield* steps.insertOne(step(a, "review", 5, 15));
        yield* steps.insertOne(step(a, "ci", 25, 30));

        yield* (yield* TokenUsagesRepository).insertMany([
          spent(a, "implement", "opus", { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }),
          spent(a, "implement", "haiku", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
          spent(a, "review", "opus", { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }),
          unreported(a, "review"),
          // Another run's call counts for nothing here.
          spent(RunId.make("b"), "implement", "opus", {
            input: 1000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ]);

        const usage = yield* readRunUsageHandler({ runId: a });

        expect(usage.computeMs).toEqual(Option.some(20 * 60_000));

        const tokens = Option.getOrThrow(usage.tokens);

        expect(tokens.tokens).toEqual(counts(16, 28, 310, 52));
        expect(tokens.unreported).toBe(true);
        expect(tokens.byModel.map((each) => [each.model, each.tokens])).toEqual([
          ["opus", counts(15, 26, 307, 48)],
          ["haiku", counts(1, 2, 3, 4)],
        ]);
        expect(tokens.byStep.map((each) => [each.step, each.tokens, each.unreported])).toEqual([
          [Option.some("implement"), counts(11, 22, 303, 44), false],
          [Option.some("review"), counts(5, 6, 7, 8), true],
        ]);
        expect(
          tokens.byStep.map((each) => [
            each.step,
            each.byModel.map((model) => [model.model, model.tokens]),
          ]),
        ).toEqual([
          [
            Option.some("implement"),
            [
              ["opus", counts(10, 20, 300, 40)],
              ["haiku", counts(1, 2, 3, 4)],
            ],
          ],
          // The unreported call names no model, so it adds none.
          [Option.some("review"), [["opus", counts(5, 6, 7, 8)]]],
        ]);
      }).pipe(Effect.provide(stores)),
  );

  effect("a run from before usage and steps were kept has neither, not zero", () =>
    Effect.gen(function* () {
      yield* (yield* RunsRepository).upsertOne(run(a, Option.some(at(30))));

      const usage = yield* readRunUsageHandler({ runId: a });

      expect(usage.tokens).toEqual(Option.none());
      expect(usage.computeMs).toEqual(Option.none());
    }).pipe(Effect.provide(stores)),
  );
});
