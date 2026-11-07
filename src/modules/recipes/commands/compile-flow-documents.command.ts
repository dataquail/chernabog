import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { DocumentProblem } from "../domain/ports/clients/flow-compiler.client.ts";
import { RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";

// What became of one document: its flow file written, already as it compiles,
// out of date (only when checking), or not written for its problems.
export class CompiledFlow extends Schema.Class<CompiledFlow, { readonly brand: "CompiledFlow" }>(
  "CompiledFlow",
)({
  flow: Schema.String,
  outcome: Schema.Literals(["wrote", "unchanged", "stale", "problems"]),
  problems: Schema.Array(DocumentProblem),
  typeChecked: Schema.Boolean,
}) {}

export class FlowDocumentsCompiled extends Schema.Class<
  FlowDocumentsCompiled,
  { readonly brand: "FlowDocumentsCompiled" }
>("FlowDocumentsCompiled")({
  flows: Schema.Array(CompiledFlow),
  // A document named that the checkout doesn't have.
  unknown: Schema.Array(Schema.String),
}) {}

// Compiles the flow documents in .chernabog/documents/ of the checkout at
// `root`, those named or else all, each to its flow file in .chernabog/flows/.
// A document with problems leaves its flow file as it was. With `check`,
// nothing is written: a flow file that isn't what its document compiles to is
// reported as stale.
export const CompileFlowDocumentsCommand = Command.make("CompileFlowDocumentsCommand", {
  payload: {
    root: Schema.String,
    names: Schema.Array(Schema.String),
    check: Schema.Boolean,
  },
  success: FlowDocumentsCompiled,
  failure: RecipeFilesFailed,
});

export type CompileFlowDocumentsPayload = Command.Payload<typeof CompileFlowDocumentsCommand>;
