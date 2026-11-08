import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// An issue a run created on its repo, such as a plan's sub-issue or a
// post-merge follow-up, as the engine saw the write that made it
// (Capabilities.Write's `creates`), and when. An entity inside the run: its
// identity is the run and the issue, and it lives and goes with the run.
export class RunCreatedIssueEntity extends Schema.Class<
  RunCreatedIssueEntity,
  { readonly brand: "RunCreatedIssueEntity" }
>("RunCreatedIssueEntity")({
  runId: RunId,
  issue: Schema.Finite,
  // ISO timestamp.
  createdAt: Schema.String,
}) {}
