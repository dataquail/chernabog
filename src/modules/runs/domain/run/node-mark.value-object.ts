import * as Schema from "effect/Schema";

// What a run did at a node of its plan: entered it (`node`), and once it left
// it, when and how (`ok` or `failed`); took one of its block's outcome
// branches (`branch`, with the outcome); or reached the `end` it is (`end`).
export const NodeMark = Schema.Literals(["node", "branch", "end"]);

export type NodeMark = typeof NodeMark.Type;
