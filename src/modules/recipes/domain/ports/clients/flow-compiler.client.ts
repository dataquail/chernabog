import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type RecipeFilesFailed } from "../../recipe/recipe.errors.ts";

// What is wrong with a flow document, at the line and column of the document
// it is about, and by the path to it there: steps[2].in.worktree.
export class DocumentProblem extends Schema.Class<
  DocumentProblem,
  { readonly brand: "DocumentProblem" }
>("DocumentProblem")({
  file: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
  path: Schema.String,
  message: Schema.String,
}) {}

// What compiling one document came to: the flow file it compiles to, none when
// it has problems, and whether its wires' types were checked, which takes
// TypeScript installed beside the repo and a document with no other problems:
// with problems, true says they are what the types' check found.
export type CompiledDocument = {
  readonly source: Option.Option<string>;
  readonly problems: ReadonlyArray<DocumentProblem>;
  readonly typeChecked: boolean;
};

// The flow documents in a checkout's .chernabog/documents/, compiled by the
// @chernabog/sdk the repo pins, which is the one its flows run with.
export type FlowCompilerClientService = {
  // Everything a document can use, as the repo's SDK says it.
  readonly catalogue: (root: string) => Effect.Effect<Schema.Json, RecipeFilesFailed>;
  // Each document's flow name, in name order.
  readonly documents: (root: string) => Effect.Effect<ReadonlyArray<string>, RecipeFilesFailed>;
  readonly compile: (
    root: string,
    flow: string,
  ) => Effect.Effect<CompiledDocument, RecipeFilesFailed>;
  // The flow file as it stands; none when there is none.
  readonly written: (
    root: string,
    flow: string,
  ) => Effect.Effect<Option.Option<string>, RecipeFilesFailed>;
  readonly write: (
    root: string,
    flow: string,
    source: string,
  ) => Effect.Effect<void, RecipeFilesFailed>;
};

export class FlowCompilerClient extends Context.Service<
  FlowCompilerClient,
  FlowCompilerClientService
>()("FlowCompilerClient") {}
