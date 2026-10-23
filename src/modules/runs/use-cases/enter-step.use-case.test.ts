import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { enterStepUseCase } from "./enter-step.use-case.ts";
import { findRunUseCase } from "./find-run.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
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

describe("enterStepUseCase", () => {
  effect("records the step a running run is in", () =>
    Effect.gen(function* () {
      expect((yield* enterStepUseCase(RunId.make("a"), "implement")).currentStep).toEqual(
        Option.some("implement"),
      );
    }).pipe(Effect.provide(RunsRepositoryFake([run("a")]))),
  );

  effect("a run that ended takes no step, and stays as it ended", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(enterStepUseCase(ended.id, "late"));

      expect(refused._tag).toBe("RunAlreadyFinished");
      expect(
        Option.map((yield* findRunUseCase(ended.id)).run, (found) => found.currentStep),
      ).toEqual(Option.some(Option.none()));
    }).pipe(Effect.provide(RunsRepositoryFake([ended]))),
  );
});
