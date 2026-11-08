// A step as om_steps stores it.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { NodeRefs } from "../../domain/plan/node-ref.value-object.ts";
import { RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { StepOutcome } from "../../domain/run/step-outcome.value-object.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

// A step's end is none, as SQL's NULL, while it runs and for a row from
// before steps kept their ends; its node, for a flow with no plan and a row
// from before steps kept their nodes, and its node's round and lane outside one.
export const StepColumns = Schema.Struct({
  run_id: Schema.String,
  step: Schema.String,
  node: Schema.optionalKey(Schema.NullOr(Schema.String)),
  node_round: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  node_lane: Schema.optionalKey(Schema.NullOr(Schema.String)),
  entered_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(StepOutcome),
});

export const toEntity = (row: typeof StepColumns.Type) =>
  RunStepEntity.make({
    runId: RunId.make(row.run_id),
    step: row.step,
    node: Option.map(Option.fromNullishOr(row.node), (id) =>
      NodeRefs.of({
        id,
        round: Option.fromNullishOr(row.node_round),
        lane: Option.fromNullishOr(row.node_lane),
      }),
    ),
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

// A step's node, as its columns hold it: each NULL where it has none.
export const nodeColumns = (step: RunStepEntity) => ({
  node: Option.getOrNull(Option.map(step.node, (node) => node.id)),
  round: Option.getOrNull(Option.flatMap(step.node, NodeRefs.roundOf)),
  lane: Option.getOrNull(Option.flatMap(step.node, NodeRefs.laneOf)),
});
