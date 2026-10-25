// A step as om_steps stores it.

import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepRoot } from "../../domain/run-step/run-step.root.ts";

export const StepColumns = Schema.Struct({
  run_id: Schema.String,
  step: Schema.String,
  entered_at: Schema.String,
});

export const toRoot = (row: typeof StepColumns.Type) =>
  RunStepRoot.make({
    runId: RunId.make(row.run_id),
    step: row.step,
    enteredAt: row.entered_at,
  });
