import * as Schema from "effect/Schema";

// A recipe: a complete flow, written out from the SDK's blocks, as a recipe
// package at one version has it. A repo copies it into its .chernabog/, where
// it's the repo's own code from then on, or imports it from the package.
export class RecipeRoot extends Schema.Class<RecipeRoot, { readonly brand: "RecipeRoot" }>(
  "RecipeRoot",
)({
  // The package it comes from, and that package's version.
  package: Schema.String,
  version: Schema.String,
  name: Schema.String,
  // One line, for the list a person chooses from.
  description: Schema.String,
  // Its flow, then the prompts it renders and the steps it runs, by path in
  // the package, which is also their path under .chernabog/.
  flow: Schema.String,
  prompts: Schema.Array(Schema.String),
  stages: Schema.Array(Schema.String),
  docs: Schema.Option(Schema.String),
}) {}
