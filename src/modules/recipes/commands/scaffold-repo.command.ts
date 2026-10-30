import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RecipeFilesFailed, ScaffoldRefused } from "../domain/recipe/recipe.errors.ts";

// One file the scaffold changed: written, brought up to date, or, for
// .gitignore, the entries it gained.
export const ScaffoldChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["written", "updated", "ignored"]),
  entries: Schema.Array(Schema.String),
});

export class Scaffolded extends Schema.Class<Scaffolded, { readonly brand: "Scaffolded" }>(
  "Scaffolded",
)({
  changes: Schema.Array(ScaffoldChange),
}) {}

// Writes the scaffold of .chernabog/ into the repo at `root`, never
// overwriting a file that is there, except the generated schemas, which are
// brought up to date: config.schema.json with the settings the repo's flows
// declare, so running it again after adding a flow describes its settings.
// package.json is written for a new .chernabog/ and left alone after that:
// its SDK pin says what the flows are written against, and only moving the
// flows (UpgradeRepoCommand) moves it. A .chernabog/ written against a newer
// SDK than this binary runs is refused, rather than moved back.
export const ScaffoldRepoCommand = Command.make("ScaffoldRepoCommand", {
  payload: { root: Schema.String },
  success: Scaffolded,
  failure: Schema.Union([RecipeFilesFailed, ScaffoldRefused]),
});

export type ScaffoldRepoPayload = Command.Payload<typeof ScaffoldRepoCommand>;
