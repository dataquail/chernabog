import { describe, expect, test } from "bun:test";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { RunCreatedIssueEntity } from "./run-created-issue.entity.ts";
import { RunCreatedIssueSpecifications } from "./run-created-issue.specification.ts";

const created = (runId: string, issue: number) =>
  RunCreatedIssueEntity.make({ runId: RunId.make(runId), issue, createdAt: "t" });

describe("RunCreatedIssueSpecifications", () => {
  const issues = [created("a", 13), created("b", 14), created("a", 15)];

  test("forRun holds of the issues one run created, as an Eq on runId", () => {
    expect(issues.filter(RunCreatedIssueSpecifications.forRun(RunId.make("a")))).toEqual([
      issues[0],
      issues[2],
    ]);
    expect(RunCreatedIssueSpecifications.forRun(RunId.make("a")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "a" }),
    );
  });
});
