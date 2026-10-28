import * as Schema from "effect/Schema";

// A marker's release can't be run: the flow no longer defines it, or the
// arguments its hold gave no longer fit. Retrying won't help; a person takes
// it off.
export class MarkerUnreleasable extends Schema.TaggedError<
  MarkerUnreleasable,
  { readonly brand: "MarkerUnreleasable" }
>()("MarkerUnreleasable", { message: Schema.String }) {}
