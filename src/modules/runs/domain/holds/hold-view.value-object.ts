import * as Schema from "effect/Schema";

// An item a flow's trigger holds, and why, as `status` shows it.
export class HoldView extends Schema.Class<HoldView, { readonly brand: "HoldView" }>("HoldView")({
  repo: Schema.String,
  persona: Schema.OptionFromNullOr(Schema.String),
  flow: Schema.String,
  itemKey: Schema.String,
  reason: Schema.String,
  at: Schema.String,
}) {}
