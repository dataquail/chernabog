import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunCreatedIssueSpecifications } from "../domain/run/run-created-issue.specification.ts";
import { RunCreatedIssuesRepository } from "../domain/run/run-created-issues.repository.ts";
import { RunCreatedIssuesRepositoryFake } from "../infrastructure/repositories/run-created-issues.repository-fake.ts";
import { recordCreatedIssueHandler } from "./record-created-issue.handler.ts";

const a = RunId.make("a");

describe("recordCreatedIssueHandler", () => {
  effect("records each issue a run created, once", () =>
    Effect.gen(function* () {
      yield* recordCreatedIssueHandler({ runId: a, issue: 13 });
      yield* recordCreatedIssueHandler({ runId: a, issue: 14 });
      yield* recordCreatedIssueHandler({ runId: a, issue: 13 });
      yield* recordCreatedIssueHandler({ runId: RunId.make("b"), issue: 20 });

      const created = yield* (yield* RunCreatedIssuesRepository).findMany(
        RunCreatedIssueSpecifications.forRun(a),
      );

      expect(created.map((issue) => issue.issue)).toEqual([13, 14]);
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunCreatedIssuesRepositoryFake([])))),
  );
});
