// The leases a run holds, each a held marker that declares one (#134, #354),
// its claim refs first among them: how long one lasts, executing or parked, how
// often the daemon renews it, and what a renewal found. A run whose lease went
// to someone else has lost its work and ends as lost.

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// How long a claim lasts unless renewed while its run executes: the team's
// limits.leaseTtl. Long enough to cover a machine asleep overnight without
// giving the work away, and far longer than clock skew between machines.
export const DEFAULT_LEASE_TTL = Duration.hours(12);

// How long while its run is parked, waiting on review, CI or a person: the
// team's limits.parkedLeaseTtl. A pull request waiting days for review is
// normal, and its state is on GitHub anyway.
export const DEFAULT_PARKED_LEASE_TTL = Duration.days(3);

// How often the daemon renews each lease of its runs in flight: the team's limits.leaseRenewEvery.
export const DEFAULT_LEASE_RENEW_EVERY = Duration.minutes(30);

export type LeaseLimits = {
  readonly ttl: Duration.Duration;
  readonly parkedTtl: Duration.Duration;
  readonly renewEvery: Duration.Duration;
};

export const DEFAULT_LEASE_LIMITS: LeaseLimits = {
  ttl: DEFAULT_LEASE_TTL,
  parkedTtl: DEFAULT_PARKED_LEASE_TTL,
  renewEvery: DEFAULT_LEASE_RENEW_EVERY,
};

// The lease a run's renewal asks for: the parked TTL while it waits on a signal.
export const leaseTtlFor = (limits: LeaseLimits, parked: boolean) => {
  if (parked) {
    return limits.parkedTtl;
  }

  return limits.ttl;
};

// What a lease was found to be: still the run's, with when it runs out and was
// last renewed; someone else's, which took it over; or gone, the run or a
// person having let it go.
export type LeaseState =
  | {
      readonly status: "held";
      readonly expiresAt: Option.Option<string>;
      readonly renewedAt: Option.Option<string>;
    }
  | { readonly status: "lost"; readonly reason: string }
  | { readonly status: "released" };

// Whether a run's leases are due a renewal at `now`: never renewed by this
// daemon, or `every` has passed since.
export const renewalDue = (
  last: Option.Option<DateTime.Utc>,
  every: Duration.Duration,
  now: DateTime.Utc,
) =>
  Option.match(last, {
    onNone: () => true,
    onSome: (at) => DateTime.isLessThanOrEqualTo(DateTime.addDuration(at, every), now),
  });

// One lease a run holds: what it is on (a claim's item, or what the marker
// names), when it runs out and when it was last renewed, as far as its source
// says; none for a claim from before leases.
export const LeaseView = Schema.Struct({
  item: Schema.String,
  expiresAt: Schema.Option(Schema.String),
  renewedAt: Schema.Option(Schema.String),
});

export type LeaseView = typeof LeaseView.Type;

// What checking a run's leases found: each still the run's (renewed, when
// asked); one lost to another run, and how; nothing to check, because the run
// has ended, has no execution, or holds no marker with a lease; or the check
// failed, which loses nothing.
export const RunLeases = Schema.TaggedUnion({
  Held: { leases: Schema.Array(LeaseView) },
  Lost: { item: Schema.String, reason: Schema.String },
  Unchecked: {},
  CheckFailed: { message: Schema.String },
});

export type RunLeases = typeof RunLeases.Type;
