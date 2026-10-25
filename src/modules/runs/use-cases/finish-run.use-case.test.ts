import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunUseCase } from "./find-run.use-case.ts";
import { finishRunUseCase } from "./finish-run.use-case.ts";

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

describe("finishRunUseCase", () => {
  effect("records how the run ended, once", () =>
    Effect.gen(function* () {
      const finished = yield* finishRunUseCase(RunId.make("a"), {
        status: "done",
        summary: "merged",
      });

      const again = yield* Effect.flip(
        finishRunUseCase(RunId.make("a"), { status: "failed", summary: "again" }),
      );

      expect([finished.status, finished.summary, Option.isSome(finished.finishedAt)]).toEqual([
        "done",
        Option.some("merged"),
        true,
      ]);
      expect(again._tag).toBe("RunAlreadyFinished");
      expect(
        Option.map((yield* findRunUseCase(RunId.make("a"))).run, (found) => found.status),
      ).toEqual(Option.some("done"));
    }).pipe(Effect.provide(RunsRepositoryFake([run("a")]))),
  );
});
