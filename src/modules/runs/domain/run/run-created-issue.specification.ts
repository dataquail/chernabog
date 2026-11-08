import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunCreatedIssueEntity } from "./run-created-issue.entity.ts";

// The issues one run created.
const forRun = (runId: RunId): Specification<RunCreatedIssueEntity> =>
  Spec.eq<RunCreatedIssueEntity, "runId">("runId", runId);

export const RunCreatedIssueSpecifications = { forRun } as const;
