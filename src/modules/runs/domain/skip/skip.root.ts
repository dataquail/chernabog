import * as Schema from "effect/Schema";

// Why a tick of a persona's flow started nothing, or nothing for one item: a
// gate, a pause, the concurrency limit. A record of what happened, as whom it
// happened then; nothing changes it after.
export class SkipRoot extends Schema.Class<SkipRoot, { readonly brand: "SkipRoot" }>("SkipRoot")({
  // The repo's name as the daemon schedules it.
  repo: Schema.String,
  persona: Schema.Option(Schema.String),
  flow: Schema.String,
  itemKey: Schema.Option(Schema.String),
  reason: Schema.String,
  // An ISO timestamp.
  at: Schema.String,
}) {}
