import * as Schema from "effect/Schema";

// What checking a run's work item found: still valid; gone, and why; not
// checked, because the run has ended, has no item or execution to ask about,
// or its flow has no stillValid; or the check failed, which is not Gone.
export const RunValidity = Schema.TaggedUnion({
  Valid: {},
  Gone: { reason: Schema.String },
  Unchecked: {},
  CheckFailed: { message: Schema.String },
});

export type RunValidity = typeof RunValidity.Type;
