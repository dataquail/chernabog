import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { StepOutcome } from "../domain/run/step-outcome.value-object.ts";

// A step a run entered ending, as its log reports it: when, and how. It ends
// the run's latest entry into the step that hasn't ended; with none (a step
// it never entered, or one that has ended already) it changes nothing.
export const FinishStepCommand = Command.make("FinishStepCommand", {
  payload: {
    runId: RunId,
    step: Schema.String,
    outcome: StepOutcome,
    // When the step ended, ISO; now when not given. A spoke reports the time
    // it ended, which the hub folds later (ADR 23, decision 3).
    at: Schema.optionalKey(Schema.String),
  },
});

export type FinishStepPayload = Command.Payload<typeof FinishStepCommand>;
