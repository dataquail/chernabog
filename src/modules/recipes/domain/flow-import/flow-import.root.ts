import * as Schema from "effect/Schema";

// A flow a checkout imports from a recipe package: its .chernabog/config.yaml's
// `flows.<flow>.from`, as "<package>/<recipe>". A dumb value; a flow's other
// settings in that file aren't the import's.
export class FlowImportRoot extends Schema.Class<
  FlowImportRoot,
  { readonly brand: "FlowImportRoot" }
>("FlowImportRoot")({
  // The checkout whose .chernabog/config.yaml says it.
  root: Schema.String,
  flow: Schema.String,
  from: Schema.String,
}) {}
