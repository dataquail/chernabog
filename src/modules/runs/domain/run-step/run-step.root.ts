import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// A step a run entered, and when: the path a run took, which its current
// step alone doesn't keep. A run entering the same step again is another row.
export class RunStepRoot extends Schema.Class<RunStepRoot, { readonly brand: "RunStepRoot" }>(
  "RunStepRoot",
)({
  runId: RunId,
  step: Schema.String,
  // ISO timestamp.
  enteredAt: Schema.String,
}) {}
