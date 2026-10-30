import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "./find-run.handler.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
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

describe("findRunHandler", () => {
  effect("is the run with the id, and none for an id no run has", () =>
    Effect.gen(function* () {
      expect(
        Option.map((yield* findRunHandler({ runId: RunId.make("a") })).run, (found) =>
          String(found.id),
        ),
      ).toEqual(Option.some("a"));
      expect((yield* findRunHandler({ runId: RunId.make("nope") })).run).toEqual(Option.none());
    }).pipe(Effect.provide(RunsRepositoryFake([run("a")]))),
  );
});
