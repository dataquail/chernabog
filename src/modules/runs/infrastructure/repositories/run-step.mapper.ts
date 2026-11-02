// A step as om_steps stores it.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { StepOutcome } from "../../domain/run/step-outcome.value-object.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

// A step's end is none, as SQL's NULL, while it runs and for a row from
// before steps kept their ends.
export const StepColumns = Schema.Struct({
  run_id: Schema.String,
  step: Schema.String,
  entered_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(StepOutcome),
});

export const toEntity = (row: typeof StepColumns.Type) =>
  RunStepEntity.make({
    runId: RunId.make(row.run_id),
    step: row.step,
    enteredAt: row.entered_at,
    finishedAt: Option.fromNullishOr(row.finished_at),
    outcome: Option.fromNullishOr(row.outcome),
  });

// Each field of a step, as the om_steps column a spec's WHERE names.
export const stepColumns: ColumnMap = {
  runId: "run_id",
  step: "step",
  enteredAt: "entered_at",
  finishedAt: "finished_at",
  outcome: "outcome",
};
