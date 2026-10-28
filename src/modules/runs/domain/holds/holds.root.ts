import * as Schema from "effect/Schema";

// The items a persona's flow found but won't start yet, and why ("waits on
// #12, #13"), as its trigger said on the flow's latest tick. Unlike a skip,
// it's the state of the flow's work now, not a log: each tick's holds replace
// its last.
export class HoldsRoot extends Schema.Class<HoldsRoot, { readonly brand: "HoldsRoot" }>(
  "HoldsRoot",
)({
  // The repo's name as the daemon schedules it.
  repo: Schema.String,
  persona: Schema.Option(Schema.String),
  flow: Schema.String,
  items: Schema.Array(Schema.Struct({ itemKey: Schema.String, reason: Schema.String })),
  // When the tick that held them ran, as an ISO timestamp.
  at: Schema.String,
}) {}
