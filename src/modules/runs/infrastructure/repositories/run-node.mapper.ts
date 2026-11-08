// A mark a run left at a node of its plan, as om_nodes stores it.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { NodeMark } from "../../domain/run/node-mark.value-object.ts";
import { RunNodeEntity } from "../../domain/run/run-node.entity.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

// What a mark has none of is SQL's NULL.
export const NodeColumns = Schema.Struct({
  run_id: Schema.String,
  mark: NodeMark,
  node: Schema.String,
  node_round: Schema.NullOr(Schema.Int),
  node_lane: Schema.NullOr(Schema.String),
  at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.String),
});

export const toEntity = (row: typeof NodeColumns.Type) =>
  RunNodeEntity.make({
    runId: RunId.make(row.run_id),
    mark: row.mark,
    node: row.node,
    round: Option.fromNullishOr(row.node_round),
    lane: Option.fromNullishOr(row.node_lane),
    at: row.at,
    finishedAt: Option.fromNullishOr(row.finished_at),
    outcome: Option.fromNullishOr(row.outcome),
  });

// Each field of a mark, as the om_nodes column a spec's WHERE names.
export const nodeColumns: ColumnMap = {
  runId: "run_id",
  mark: "mark",
  node: "node",
  round: "node_round",
  lane: "node_lane",
  at: "at",
  finishedAt: "finished_at",
  outcome: "outcome",
};
