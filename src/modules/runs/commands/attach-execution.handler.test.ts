import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { attachExecutionHandler } from "./attach-execution.handler.ts";

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

describe("attachExecutionHandler", () => {
  effect("records the run's workflow execution", () =>
    Effect.gen(function* () {
      yield* attachExecutionHandler({ runId: RunId.make("a"), executionId: "x" });

      expect(
        Option.flatMap(
          (yield* findRunHandler({ runId: RunId.make("a") })).run,
          (found) => found.executionId,
        ),
      ).toEqual(Option.some("x"));
    }).pipe(Effect.provide([RunsRepositoryFake([run("a")]), PassThroughUnitOfWork])),
  );

  effect("fails for a run no one started", () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(
          attachExecutionHandler({ runId: RunId.make("nope"), executionId: "x" }),
        ))._tag,
      ).toBe("RunNotFound");
    }).pipe(Effect.provide([RunsRepositoryFake([]), PassThroughUnitOfWork])),
  );
});
