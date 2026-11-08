import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { NodeRef } from "../plan/node-ref.value-object.ts";
import { StepOutcome } from "./step-outcome.value-object.ts";

// A step a run entered, and when: the path a run took, which its current
// step alone doesn't keep. A run entering the same step again is another row.
// An entity inside the run: it has an identity of its own (the run and when
// it entered), but no lifecycle apart from the run it belongs to. Once it
// ends, when and how; none while it runs, for one that was interrupted, and
// for one entered before steps kept their ends.
export class RunStepEntity extends Schema.Class<RunStepEntity, { readonly brand: "RunStepEntity" }>(
  "RunStepEntity",
)({
  runId: RunId,
  step: Schema.String,
  // Where in its plan the run entered the step; none for a flow with no plan,
  // and for a step entered before steps kept their nodes.
  node: Schema.Option(NodeRef),
  // ISO timestamp.
  enteredAt: Schema.String,
  // ISO timestamp.
  finishedAt: Schema.Option(Schema.String),
  outcome: Schema.Option(StepOutcome),
}) {}
