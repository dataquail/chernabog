import * as Schema from "effect/Schema";

import { StepLogs } from "../../../../kernel/run-log-line.value-object.ts";
import { NodeRef } from "../plan/node-ref.value-object.ts";
import { RunWait } from "../run-wait/run-wait-view.value-object.ts";
import { StepOutcome } from "./step-outcome.value-object.ts";

// A step a run entered, and when; once it has ended, when and how. A step
// still running has neither, nor one that was interrupted (it shows again,
// entered anew, when its run resumes), nor one from before steps kept ends.
// `node` is where in its plan the run entered it, absent for a flow with no
// plan and for a step from before steps kept their nodes.
export class RunStep extends Schema.Class<RunStep, { readonly brand: "RunStep" }>("RunStep")({
  step: Schema.String,
  node: Schema.optionalKey(NodeRef),
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

// A node of its plan a run entered, whether or not it ran a step there, and
// when; once it left it, when and how.
export class RunNodeVisit extends Schema.Class<RunNodeVisit, { readonly brand: "RunNodeVisit" }>(
  "RunNodeVisit",
)({
  node: NodeRef,
  enteredAt: Schema.String,
  finishedAt: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(StepOutcome),
}) {}

// An outcome branch of a node's block a run took, and when.
export class RunBranch extends Schema.Class<RunBranch, { readonly brand: "RunBranch" }>(
  "RunBranch",
)({
  node: NodeRef,
  outcome: Schema.String,
  takenAt: Schema.String,
}) {}

// An `end` a run, or a lane of it, reached, and when.
export class RunEnd extends Schema.Class<RunEnd, { readonly brand: "RunEnd" }>("RunEnd")({
  node: NodeRef,
  reachedAt: Schema.String,
}) {}

// Where a run has been and what it waits on: the steps it entered, in order,
// none for a run from before steps were kept, and the signals it's parked on.
// `lanes` are those its flow declared, and `stepLogs` how its log splits by
// step, which GET /runs/:id/log?step= follows. For a run of a flow with a
// plan, `plan` is the hash of the plan it started with (GET /plans/:hash),
// and `nodes`, `branches` and `ends` where in it the run went, in order.
export class RunHistory extends Schema.Class<RunHistory, { readonly brand: "RunHistory" }>(
  "RunHistory",
)({
  steps: Schema.Array(RunStep),
  waits: Schema.Array(RunWait),
  lanes: Schema.optionalKey(Schema.Array(RunLane)),
  stepLogs: Schema.optionalKey(StepLogs),
  plan: Schema.optionalKey(Schema.String),
  nodes: Schema.optionalKey(Schema.Array(RunNodeVisit)),
  branches: Schema.optionalKey(Schema.Array(RunBranch)),
  ends: Schema.optionalKey(Schema.Array(RunEnd)),
}) {}
