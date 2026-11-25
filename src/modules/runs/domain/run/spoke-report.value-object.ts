import * as Schema from "effect/Schema";

// One report a run's spoke wrote in its journal's `spoke_reports` (ADR 23,
// decision 3), as it lies there: its place in the journal's order, when the
// spoke wrote it, the tag of the runs' command it carries, and that command's
// payload as JSON, encoded with the command's own schema. The hub folds it
// into state.db by dispatching that command.
export const SpokeReport = Schema.Struct({
  seq: Schema.Finite,
  at: Schema.String,
  tag: Schema.String,
  payload: Schema.String,
});

export type SpokeReport = typeof SpokeReport.Type;
