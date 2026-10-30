import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { nameSubjectUseCase } from "./name-subject.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-123",
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

describe("nameSubjectUseCase", () => {
  effect("records each subject a running run names, once", () =>
    Effect.gen(function* () {
      const a = RunId.make("a");
      expect((yield* nameSubjectUseCase(a, "pr-124")).subjects).toEqual(["pr-124"]);
      yield* nameSubjectUseCase(a, "pr-125");
      yield* nameSubjectUseCase(a, "pr-124");
      expect(
        Option.map((yield* findRunHandler({ runId: a })).run, (found) => found.subjects),
      ).toEqual(Option.some(["pr-124", "pr-125"]));
    }).pipe(Effect.provide(RunsRepositoryFake([run("a")]))),
  );

  effect("a run that ended names nothing, and one that isn't there is not found", () =>
    Effect.gen(function* () {
      const ended = run("ended", {
        status: "done",
        summary: Option.some("ready for review"),
        finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
      });

      expect((yield* Effect.flip(nameSubjectUseCase(ended.id, "pr-9")))._tag).toBe(
        "RunAlreadyFinished",
      );
      expect((yield* Effect.flip(nameSubjectUseCase(RunId.make("gone"), "pr-9")))._tag).toBe(
        "RunNotFound",
      );
    }).pipe(
      Effect.provide(
        RunsRepositoryFake([
          run("ended", {
            status: "done",
            summary: Option.some("ready for review"),
            finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
          }),
        ]),
      ),
    ),
  );
});
