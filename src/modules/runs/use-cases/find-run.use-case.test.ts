import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
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

describe("findRunUseCase", () => {
  effect("is the run with the id, and none for an id no run has", () =>
    Effect.gen(function* () {
      expect(
        Option.map((yield* findRunUseCase(RunId.make("a"))).run, (found) => String(found.id)),
      ).toEqual(Option.some("a"));
      expect((yield* findRunUseCase(RunId.make("nope"))).run).toEqual(Option.none());
    }).pipe(Effect.provide(RunsRepositoryFake([run("a")]))),
  );
});
