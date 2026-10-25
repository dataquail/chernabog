import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunStepsRepositoryFake } from "../infrastructure/repositories/run-steps.repository-fake.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { enterStepUseCase } from "./enter-step.use-case.ts";
import { findRunUseCase } from "./find-run.use-case.ts";
import { readRunHistoryUseCase } from "./read-run-history.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    sdkVersion: "0.6.0",
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
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const ended = run("ended", {
  status: "done",
  summary: Option.some("merged"),
  finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
});

const steps = (runs: ReadonlyArray<RunRoot>) =>
  Layer.mergeAll(RunsRepositoryFake(runs), RunStepsRepositoryFake([]), RunWaitsRepositoryFake([]));

describe("enterStepUseCase", () => {
  effect("records the step a running run is in, and each step it has entered", () =>
    Effect.gen(function* () {
      const a = RunId.make("a");
      yield* enterStepUseCase(a, "claim");
      yield* enterStepUseCase(a, "ci");

      expect((yield* enterStepUseCase(a, "ci")).currentStep).toEqual(Option.some("ci"));
      expect((yield* readRunHistoryUseCase(a)).steps.map((found) => found.step)).toEqual([
        "claim",
        "ci",
        "ci",
      ]);
    }).pipe(Effect.provide(steps([run("a")]))),
  );

  effect("a run that ended takes no step, and stays as it ended", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(enterStepUseCase(ended.id, "late"));

      expect(refused._tag).toBe("RunAlreadyFinished");
      expect(
        Option.map((yield* findRunUseCase(ended.id)).run, (found) => found.currentStep),
      ).toEqual(Option.some(Option.none()));
      expect((yield* readRunHistoryUseCase(ended.id)).steps).toEqual([]);
    }).pipe(Effect.provide(steps([ended]))),
  );
});
