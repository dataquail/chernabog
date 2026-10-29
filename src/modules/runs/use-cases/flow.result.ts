import * as Schema from "effect/Schema";

import { WorkItem } from "../domain/run/work-item.value-object.ts";
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

// What a tick of a persona's flow would do: the work whose signals go to the
// runs in flight (none when its trigger didn't run), the work it may start
// runs for, in order, why it would start nothing when it wouldn't, and, once
// its trigger ran, what it queued for this machine, left for others, and
// says waits on someone, with who and why.
export class TickPlan extends Schema.Class<TickPlan, { readonly brand: "TickPlan" }>("TickPlan")({
  signalled: Schema.Array(WorkItem),
  start: Schema.Array(WorkItem),
  skipped: Schema.Option(Schema.String),
  routed: Schema.Option(
    Schema.Struct({
      queued: Schema.Array(Schema.String),
      elsewhere: Schema.Array(Schema.String),
      waiting: Schema.Array(Schema.String),
    }),
  ),
}) {}

// Whether a flow's own gate holds its runs back, and why.
export class Gated extends Schema.Class<Gated, { readonly brand: "Gated" }>("Gated")({
  held: Schema.Option(Schema.String),
}) {}
