import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { PullRequestOpened } from "../domain/run/run.events.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { nameSubjectHandler } from "./name-subject.handler.ts";

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

describe("nameSubjectHandler", () => {
  effect("records each subject a running run names, once", () =>
    Effect.gen(function* () {
      const a = RunId.make("a");
      expect((yield* nameSubjectHandler({ runId: a, subject: "pr-124" })).subjects).toEqual([
        "pr-124",
      ]);
      yield* nameSubjectHandler({ runId: a, subject: "pr-125" });
      yield* nameSubjectHandler({ runId: a, subject: "pr-124" });
      yield* nameSubjectHandler({ runId: a, subject: "issue-7" });
      expect(
        Option.map((yield* findRunHandler({ runId: a })).run, (found) => found.subjects),
      ).toEqual(Option.some(["pr-124", "pr-125", "issue-7"]));
      expect(yield* DispatchedEvents).toEqual([
        PullRequestOpened.make({
          eventId: "a:subject:pr-124",
          runId: a,
          repo: "demo",
          number: 124,
        }),
        PullRequestOpened.make({
          eventId: "a:subject:pr-125",
          runId: a,
          repo: "demo",
          number: 125,
        }),
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunsRepositoryFake([run("a")])))),
  );

  effect("a run that ended names nothing, and one that isn't there is not found", () =>
    Effect.gen(function* () {
      const ended = run("ended", {
        status: "done",
        summary: Option.some("ready for review"),
        finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
      });

      expect(
        (yield* Effect.flip(nameSubjectHandler({ runId: ended.id, subject: "pr-9" })))._tag,
      ).toBe("RunAlreadyFinished");
      expect(
        (yield* Effect.flip(nameSubjectHandler({ runId: RunId.make("gone"), subject: "pr-9" })))
          ._tag,
      ).toBe("RunNotFound");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          RecordedEvents,
          RunsRepositoryFake([
            run("ended", {
              status: "done",
              summary: Option.some("ready for review"),
              finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
            }),
          ]),
        ),
      ),
    ),
  );
});
