import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// Tokens summed over some of a run's agent calls: each category, and their
// total, which sums all four (cache reads dominate it). A count an adapter
// didn't report adds nothing.
export class TokenCounts extends Schema.Class<TokenCounts, { readonly brand: "TokenCounts" }>(
  "TokenCounts",
)({
  total: Schema.Finite,
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
}) {}

// What a run's calls spent on one model.
export class ModelTokens extends Schema.Class<ModelTokens, { readonly brand: "ModelTokens" }>(
  "ModelTokens",
)({ model: Schema.String, tokens: TokenCounts }) {}

// What a run's calls spent in one step, none for calls made outside any, by
// model, and whether any of them went unreported.
export class StepTokens extends Schema.Class<StepTokens, { readonly brand: "StepTokens" }>(
  "StepTokens",
)({
  step: Schema.Option(Schema.String),
  tokens: TokenCounts,
  byModel: Schema.Array(ModelTokens),
  unreported: Schema.Boolean,
}) {}

// What a run's agent calls spent, by model and by step, in the order each was
// first recorded. `unreported` when any call's adapter couldn't say, so the
// totals are a floor ("at least").
export class RunTokens extends Schema.Class<RunTokens, { readonly brand: "RunTokens" }>(
  "RunTokens",
)({
  tokens: TokenCounts,
  byModel: Schema.Array(ModelTokens),
  byStep: Schema.Array(StepTokens),
  unreported: Schema.Boolean,
}) {}

// A run's token usage, none for a run that recorded none (one from before
// usage was kept), and its compute time in milliseconds: the time at least one
// of its steps covers, overlaps counted once; none for a run with no steps
// recorded (one from before steps were kept). Not zero, either of them.
export class RunUsage extends Schema.Class<RunUsage, { readonly brand: "RunUsage" }>("RunUsage")({
  tokens: Schema.Option(RunTokens),
  computeMs: Schema.Option(Schema.Finite),
}) {}

// What a run spent: its tokens and its compute time, for a person looking at it.
export const ReadRunUsageQuery = Query.make("ReadRunUsageQuery", {
  payload: { runId: RunId },
  success: RunUsage,
});

export type ReadRunUsagePayload = Query.Payload<typeof ReadRunUsageQuery>;
