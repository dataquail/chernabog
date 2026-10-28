import * as Schema from "effect/Schema";

// The lease on one claim a run holds: when it runs out and when it was last
// renewed, as its claim commit says; none for a claim from before leases.
export const LeaseView = Schema.Struct({
  item: Schema.String,
  expiresAt: Schema.Option(Schema.String),
  renewedAt: Schema.Option(Schema.String),
});

export type LeaseView = typeof LeaseView.Type;

// What checking a run's leases found: each still the run's (renewed, when
// asked); one lost to another run, and how; nothing to check, because the run
// has ended, has no execution, or holds no claim; or the check failed, which
// loses nothing.
export const RunLeases = Schema.TaggedUnion({
  Held: { leases: Schema.Array(LeaseView) },
  Lost: { item: Schema.String, reason: Schema.String },
  Unchecked: {},
  CheckFailed: { message: Schema.String },
});

export type RunLeases = typeof RunLeases.Type;
