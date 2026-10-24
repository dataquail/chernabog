import * as Schema from "effect/Schema";

// What a rehearsal's cleanup removed, and what it couldn't, one line each.
export class CleanUp extends Schema.Class<CleanUp, { readonly brand: "CleanUp" }>("CleanUp")({
  removed: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
}) {}
