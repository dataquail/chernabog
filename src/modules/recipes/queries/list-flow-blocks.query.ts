import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

const Kinds = Schema.Record(Schema.String, Schema.String);

const BlockInput = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  under: Schema.Literals(["in", "with", "in or with"]),
  kind: Schema.String,
});

const BlockOutcome = Schema.Struct({
  name: Schema.String,
  mustRoute: Schema.Boolean,
  binds: Schema.String,
});

const CatalogueBlock = Schema.Struct({
  name: Schema.String,
  about: Schema.String,
  inputs: Schema.Array(BlockInput),
  // A word for a single value, or a word for each field.
  gives: Schema.Union([Schema.String, Kinds]),
  outcomes: Schema.Array(BlockOutcome),
  // What each error it can raise comes to.
  failures: Kinds,
  before: Schema.Array(Schema.String),
  needs: Schema.Array(Schema.String),
  opens: Schema.Array(Schema.String),
  closes: Schema.Array(Schema.String),
  waits: Schema.Boolean,
});

// One of the repo's own Effect stages, from .chernabog/stages/, which a
// document runs with `stage:`: what it takes and gives, by its schemas, and
// the failures a document must say what to do about.
const CatalogueStage = Schema.Struct({
  name: Schema.String,
  inputs: Schema.Array(BlockInput),
  gives: Schema.Union([Schema.String, Kinds]),
  failures: Schema.Array(Schema.String),
});

// Everything a flow document can use in this repo, as its SDK says.
export class FlowCatalogue extends Schema.Class<FlowCatalogue, { readonly brand: "FlowCatalogue" }>(
  "FlowCatalogue",
)({
  // How a document is written.
  format: Schema.String,
  subjects: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // Whether a person can start a flow on it, with start: true; none from an SDK from before.
      start: Schema.optionalKey(Schema.Boolean),
      trigger: Schema.Array(Schema.String),
      failureContext: Schema.Array(Schema.String),
    }),
  ),
  sources: Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String, with: Kinds })),
  loopStates: Schema.Array(Schema.String),
  laneScopes: Schema.Array(Schema.String),
  blocks: Schema.Array(CatalogueBlock),
  // None from an SDK from before stages.
  stages: Schema.optionalKey(Schema.Array(CatalogueStage)),
}) {}

// The repo's SDK couldn't say what a document can use.
export class FlowBlocksUnavailable extends Schema.TaggedError<
  FlowBlocksUnavailable,
  { readonly brand: "FlowBlocksUnavailable" }
>()("FlowBlocksUnavailable", { message: Schema.String }) {}

// Everything a flow document can use in the repo at `root`, by the SDK it pins:
// the blocks, each with what it takes, gives and comes to and the order it runs
// in, the sources, the subjects, what its loops and lanes can name, and the
// repo's own Effect stages.
export const ListFlowBlocksQuery = Query.make("ListFlowBlocksQuery", {
  payload: { root: Schema.String },
  success: FlowCatalogue,
  failure: FlowBlocksUnavailable,
});

export type ListFlowBlocksPayload = Query.Payload<typeof ListFlowBlocksQuery>;
