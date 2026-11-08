import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunCreatedIssueEntity } from "../../domain/run/run-created-issue.entity.ts";
import { RunCreatedIssueSpecifications } from "../../domain/run/run-created-issue.specification.ts";
import { RunCreatedIssuesRepository } from "../../domain/run/run-created-issues.repository.ts";
import { RunCreatedIssuesRepositoryLive } from "./run-created-issues.repository-live.ts";

const a = RunId.make("a");

const created = (runId: RunId, issue: number, createdAt: string) =>
  RunCreatedIssueEntity.make({ runId, issue, createdAt });

describe("RunCreatedIssuesRepositoryLive", () => {
  effect("keeps each issue a run created once, in the order it created them", () =>
    Effect.gen(function* () {
      const issues = yield* RunCreatedIssuesRepository;
      yield* issues.insertOne(created(a, 14, "t1"));
      yield* issues.insertOne(created(RunId.make("b"), 20, "t2"));
      yield* issues.insertOne(created(a, 13, "t3"));
      yield* issues.insertOne(created(a, 14, "t4"));

      expect(yield* issues.findMany(RunCreatedIssueSpecifications.forRun(a))).toEqual([
        created(a, 14, "t1"),
        created(a, 13, "t3"),
      ]);
      expect(yield* issues.findMany(RunCreatedIssueSpecifications.forRun(RunId.make("c")))).toEqual(
        [],
      );
    }).pipe(
      Effect.provide(RunCreatedIssuesRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void)))),
    ),
  );
});
