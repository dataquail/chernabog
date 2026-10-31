import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunFinished } from "../domain/run/run.events.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { finishRunHandler } from "./finish-run.handler.ts";

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

describe("finishRunHandler", () => {
  effect("records how the run ended, once", () =>
    Effect.gen(function* () {
      const finished = yield* finishRunHandler({
        runId: RunId.make("a"),
        status: "done",
        summary: "merged",
      });

      const again = yield* Effect.flip(
        finishRunHandler({ runId: RunId.make("a"), status: "failed", summary: "again" }),
      );

      expect([finished.status, finished.summary, Option.isSome(finished.finishedAt)]).toEqual([
        "done",
        Option.some("merged"),
        true,
      ]);
      expect(again._tag).toBe("RunAlreadyFinished");
      expect(
        Option.map(
          (yield* findRunHandler({ runId: RunId.make("a") })).run,
          (found) => found.status,
        ),
      ).toEqual(Option.some("done"));
      expect(yield* DispatchedEvents).toEqual([
        RunFinished.make({
          eventId: "a:finished",
          runId: RunId.make("a"),
          status: "done",
          summary: "merged",
          finishedAt: Option.getOrThrow(finished.finishedAt),
        }),
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunsRepositoryFake([run("a")])))),
  );
});
