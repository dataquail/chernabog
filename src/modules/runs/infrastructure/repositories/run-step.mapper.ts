// A step as om_steps stores it.

import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepRoot } from "../../domain/run-step/run-step.root.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

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

// Each field of a step, as the om_steps column a spec's WHERE names.
export const stepColumns: ColumnMap = { runId: "run_id", step: "step", enteredAt: "entered_at" };
