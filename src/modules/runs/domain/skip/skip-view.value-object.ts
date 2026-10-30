import * as Schema from "effect/Schema";

const Maybe = Schema.OptionFromNullOr(Schema.String);

// Why a tick started nothing, as `status` shows it: what listing the skips
// answers, and what recording one returns.
export class SkipView extends Schema.Class<SkipView, { readonly brand: "SkipView" }>("SkipView")({
  repo: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  itemKey: Maybe,
  reason: Schema.String,
  at: Schema.String,
}) {}

// Whether a flow's own gate holds its runs back, and why.
export class Gated extends Schema.Class<Gated, { readonly brand: "Gated" }>("Gated")({
  held: Schema.Option(Schema.String),
}) {}
