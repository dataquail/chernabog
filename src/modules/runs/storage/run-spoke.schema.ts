// A row of om_spokes, in state.db: a run's live spoke as the hub that spawned
// it recorded it (ADR 23, decision 7). The spokes repository writes it and
// the runs queries read it, so its shape is named once, here. `ending` is the
// ending the hub means for it, as JSON, or null before it means one; turning
// it into the domain's stays each side's.

import * as Schema from "effect/Schema";

export const RunSpokeRow = Schema.Struct({
  run_id: Schema.String,
  pid: Schema.Finite,
  started_at: Schema.OptionFromNullOr(Schema.String),
  hub_pid: Schema.Finite,
  hub_started_at: Schema.OptionFromNullOr(Schema.String),
  folded_seq: Schema.Finite,
  ending: Schema.OptionFromNullOr(Schema.String),
});

export type RunSpokeRow = typeof RunSpokeRow.Type;
