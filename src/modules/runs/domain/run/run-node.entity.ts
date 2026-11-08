import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { NodeMark } from "./node-mark.value-object.ts";

// A mark a run left at a node of its plan, in a round of a repeat and a lane
// of a forEach, each none outside one. A run leaves each mark at a node in a
// round and a lane once: a resumed run that passes it again leaves none. An
// entity inside the run, with no lifecycle apart from it.
export class RunNodeEntity extends Schema.Class<RunNodeEntity, { readonly brand: "RunNodeEntity" }>(
  "RunNodeEntity",
)({
  runId: RunId,
  mark: NodeMark,
  node: Schema.String,
  round: Schema.Option(Schema.Int),
  lane: Schema.Option(Schema.String),
  // ISO timestamp: when the run entered the node, took the branch, or reached the end.
  at: Schema.String,
  // ISO timestamp: when the run left a node; none while it is in it, and for a branch or an end.
  finishedAt: Schema.Option(Schema.String),
  // How the run left a node, or the outcome whose branch it took; none otherwise.
  outcome: Schema.Option(Schema.String),
}) {}
