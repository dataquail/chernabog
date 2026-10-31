import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// A step a run entered, and when: the path a run took, which its current
// step alone doesn't keep. A run entering the same step again is another row.
// An entity inside the run: it has an identity of its own (the run and when
// it entered), but no lifecycle apart from the run it belongs to.
export class RunStepEntity extends Schema.Class<RunStepEntity, { readonly brand: "RunStepEntity" }>(
  "RunStepEntity",
)({
  runId: RunId,
  step: Schema.String,
  // ISO timestamp.
  enteredAt: Schema.String,
}) {}
