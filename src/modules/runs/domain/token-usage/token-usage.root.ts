import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// What one agent call of a run spent on one model, or, for a call whose
// adapter couldn't say (`reported` false), that it spent something unknown: a
// row with no model and no counts. Not reported is not zero. A record of what
// happened; nothing changes it after. A run's totals are summed from these
// when asked, never stored. Apart from the quota gate's usage (domain/usage/).
export class TokenUsageRoot extends Schema.Class<
  TokenUsageRoot,
  { readonly brand: "TokenUsageRoot" }
>("TokenUsageRoot")({
  runId: RunId,
  // The activity the call was made in (core's CurrentActivity); none outside any.
  step: Schema.Option(Schema.String),
  adapter: Schema.String,
  sessionId: Schema.String,
  model: Schema.Option(Schema.String),
  input: Schema.Option(Schema.Finite),
  output: Schema.Option(Schema.Finite),
  cacheRead: Schema.Option(Schema.Finite),
  cacheWrite: Schema.Option(Schema.Finite),
  reported: Schema.Boolean,
  // ISO timestamp.
  recordedAt: Schema.String,
}) {}
