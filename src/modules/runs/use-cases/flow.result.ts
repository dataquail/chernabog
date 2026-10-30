import * as Schema from "effect/Schema";

export class Delivered extends Schema.Class<Delivered, { readonly brand: "Delivered" }>(
  "Delivered",
)({
  count: Schema.Int,
}) {}

// Whether a flow's own gate holds its runs back, and why.
export class Gated extends Schema.Class<Gated, { readonly brand: "Gated" }>("Gated")({
  held: Schema.Option(Schema.String),
}) {}
