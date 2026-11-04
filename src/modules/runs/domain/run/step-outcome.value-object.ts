import * as Schema from "effect/Schema";

// How a step a run entered ended: it succeeded, or it failed (an error or a
// defect). A step interrupted, as a run stopping interrupts it, has none.
export const StepOutcome = Schema.Literals(["ok", "failed"]);

export type StepOutcome = typeof StepOutcome.Type;
