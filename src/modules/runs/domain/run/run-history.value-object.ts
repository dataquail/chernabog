import * as Schema from "effect/Schema";

import { StepLogs } from "../../../../kernel/run-log-line.value-object.ts";
import { RunWait } from "../run-wait/run-wait-view.value-object.ts";
import { StepOutcome } from "./step-outcome.value-object.ts";

// A step a run entered, and when; once it has ended, when and how. A step
// still running has neither, nor one that was interrupted (it shows again,
// entered anew, when its run resumes), nor one from before steps kept ends.
export class RunStep extends Schema.Class<RunStep, { readonly brand: "RunStep" }>("RunStep")({
  step: Schema.String,
  enteredAt: Schema.String,
  finishedAt: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(StepOutcome),
}) {}

// A lane of a run, as its flow declared it: the id its steps carry after `#`
// (`task-12` of `implement#task-12`), and the lanes it waited on.
export class RunLane extends Schema.Class<RunLane, { readonly brand: "RunLane" }>("RunLane")({
  lane: Schema.String,
  needs: Schema.Array(Schema.String),
}) {}

// Where a run has been and what it waits on: the steps it entered, in order,
// none for a run from before steps were kept, and the signals it's parked on.
// `lanes` are those its flow declared, and `stepLogs` how its log splits by
// step, which GET /runs/:id/log?step= follows.
export class RunHistory extends Schema.Class<RunHistory, { readonly brand: "RunHistory" }>(
  "RunHistory",
)({
  steps: Schema.Array(RunStep),
  waits: Schema.Array(RunWait),
  lanes: Schema.optionalKey(Schema.Array(RunLane)),
  stepLogs: Schema.optionalKey(StepLogs),
}) {}
