import * as Schema from "effect/Schema";

import { RunView } from "./run.result.ts";

// A run asked to start: the run it is (a new one, or the one already in
// flight for the item), and whether it's new.
export class StartedRun extends Schema.Class<StartedRun, { readonly brand: "StartedRun" }>(
  "StartedRun",
)({
  run: Schema.Option(RunView),
  started: Schema.Boolean,
}) {}

export class Delivered extends Schema.Class<Delivered, { readonly brand: "Delivered" }>(
  "Delivered",
)({
  count: Schema.Int,
}) {}

// Whether a flow's own gate holds its runs back, and why.
export class Gated extends Schema.Class<Gated, { readonly brand: "Gated" }>("Gated")({
  held: Schema.Option(Schema.String),
}) {}
