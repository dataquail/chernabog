// A row of om_plans, in state.db: a plan runs started with, kept once by its
// hash, as JSON. The run plans repository writes it and the runs queries read
// it, so its shape is named once, here; decoding the plan stays each side's.

import * as Schema from "effect/Schema";

export const PlanRow = Schema.Struct({
  hash: Schema.String,
  plan: Schema.fromJsonString(Schema.Json),
});

export type PlanRow = typeof PlanRow.Type;
