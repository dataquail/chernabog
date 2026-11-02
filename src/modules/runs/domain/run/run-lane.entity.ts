import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// One lane of a run, as its flow declared it (core's Lanes.declare): the id
// its steps carry after `#`, and the lanes it waited on, in the order they
// were first declared. An entity inside the run: its identity is the run and
// the lane, and it lives and goes with the run.
export class RunLaneEntity extends Schema.Class<RunLaneEntity, { readonly brand: "RunLaneEntity" }>(
  "RunLaneEntity",
)({
  runId: RunId,
  lane: Schema.String,
  needs: Schema.Array(Schema.String),
}) {}
