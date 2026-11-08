import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunCreatedIssueEntity } from "./run-created-issue.entity.ts";

// The issues runs created: `insertOne` keeps one, once (an issue a run
// created is recorded again, as a resumed run's step finds it, changes
// nothing), and `findMany` reads those a spec (RunCreatedIssueSpecifications)
// holds of, in the order they were created.
export type RunCreatedIssuesRepositoryService = {
  readonly findMany: (
    spec: Specification<RunCreatedIssueEntity>,
  ) => Effect.Effect<ReadonlyArray<RunCreatedIssueEntity>>;
  readonly insertOne: (created: RunCreatedIssueEntity) => Effect.Effect<void>;
};

export class RunCreatedIssuesRepository extends Context.Service<
  RunCreatedIssuesRepository,
  RunCreatedIssuesRepositoryService
>()("RunCreatedIssuesRepository") {}
