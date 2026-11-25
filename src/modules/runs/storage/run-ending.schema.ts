// How a run in om_runs ended, as the queries that count its item's endings
// read it: its status, when it finished, and how many runs of its item in a
// row ended with their spoke silent, this one included, or null for a run
// that ended any other way (ADR 23, decision 2). The runs repository writes
// these columns.

import * as Schema from "effect/Schema";

export const RunEndingRow = Schema.Struct({
  status: Schema.String,
  silent_exits: Schema.OptionFromNullOr(Schema.Finite),
});

export type RunEndingRow = typeof RunEndingRow.Type;
