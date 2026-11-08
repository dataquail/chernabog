// An issue a run created, as om_created_issues stores it.

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunCreatedIssueEntity } from "../../domain/run/run-created-issue.entity.ts";
import { CreatedIssueRow } from "../../storage/created-issue.schema.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

export const CreatedIssueColumns = CreatedIssueRow;

export const toEntity = (row: CreatedIssueRow) =>
  RunCreatedIssueEntity.make({
    runId: RunId.make(row.run_id),
    issue: row.issue,
    createdAt: row.created_at,
  });

// Each field of a created issue, as the om_created_issues column a spec's WHERE names.
export const createdIssueColumns: ColumnMap = {
  runId: "run_id",
  issue: "issue",
  createdAt: "created_at",
};
