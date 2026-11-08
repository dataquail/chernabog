// A row of om_created_issues, in state.db: an issue a run created, and when.
// The created-issues repository writes it and the runs queries read it, so
// its shape is named once, here; turning one into an entity stays the
// repository's mapper's.

import * as Schema from "effect/Schema";

export const CreatedIssueRow = Schema.Struct({
  run_id: Schema.String,
  issue: Schema.Finite,
  created_at: Schema.String,
});

export type CreatedIssueRow = typeof CreatedIssueRow.Type;
