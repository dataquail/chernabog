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

// What a tick of a persona's flow found and did: the runs it started, why it
// started nothing when it didn't (or stopped short), and, once its trigger
// ran, what it queued for this machine and left for others.
export class TickOutcome extends Schema.Class<TickOutcome, { readonly brand: "TickOutcome" }>(
  "TickOutcome",
)({
  started: Schema.Array(RunView),
  skipped: Schema.Option(Schema.String),
  routed: Schema.Option(
    Schema.Struct({
      queued: Schema.Array(Schema.String),
      elsewhere: Schema.Array(Schema.String),
    }),
  ),
}) {}
