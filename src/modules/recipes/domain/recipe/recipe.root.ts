import * as Schema from "effect/Schema";

// A recipe: a complete flow, written out from the SDK's blocks, that a person
// chooses to bake into a repo's .chernabog/. Once baked it's the repo's own
// code, and chernabog never rewrites it.
export class RecipeRoot extends Schema.Class<RecipeRoot, { readonly brand: "RecipeRoot" }>(
  "RecipeRoot",
)({
  name: Schema.String,
  // One line, for the list a person chooses from.
  description: Schema.String,
  // Its flow, flows/<name>.ts, first; then the prompts it renders.
  files: Schema.NonEmptyArray(Schema.String),
}) {}
