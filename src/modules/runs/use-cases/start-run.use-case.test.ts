import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { startRunUseCase } from "./start-run.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    executionId: Option.none(),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const starting = {
  id: RunId.make("new"),
  repo: "demo",
  persona: Option.some("bob"),
  flow: "review",
  itemKey: "pr-1",
  itemTitle: Option.some("Fix it"),
  itemUrl: Option.none(),
};

describe("startRunUseCase", () => {
  effect("records the run running, and stores it", () =>
    Effect.gen(function* () {
      const started = yield* startRunUseCase(starting);

      expect([String(started.id), started.status, started.itemTitle]).toEqual([
        "new",
        "running",
        Option.some("Fix it"),
      ]);
      expect(Option.isSome(yield* (yield* RunsRepository).findOne(RunId.make("new")))).toBe(true);
    }).pipe(Effect.provide(RunsRepositoryFake([run("done", { status: "done" })]))),
  );

  effect("fails naming the run already in flight for the persona's item, storing nothing", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(startRunUseCase(starting));

      expect([refused._tag, String(refused.runId)]).toEqual(["RunAlreadyActive", "a"]);
      expect(yield* (yield* RunsRepository).findOne(RunId.make("new"))).toEqual(Option.none());
    }).pipe(Effect.provide(RunsRepositoryFake([run("a")]))),
  );
});
