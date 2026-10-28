// The leases on the claims a run holds (#134): how long one lasts, executing
// or parked, how often the daemon renews it, and what a renewal found. A run
// whose claim names another run has lost its work item and ends as lost.

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

// The name of the marker a run holds for each claim ref it took (core's
// Claims.refMarker), and the arguments it holds it with.
export const CLAIM_REF_MARKER = "chernabog/claim-ref";

export const ClaimRefArgs = Schema.Struct({ item: Schema.String, runId: Schema.String });

// The lease a run's renewal asks for: the parked TTL while it waits on a signal.
export const leaseTtlFor = (limits: LeaseLimits, parked: boolean) => {
  if (parked) {
    return limits.parkedTtl;
  }

  return limits.ttl;
};

// What a lease on one claim was found to be: still the run's, with when it
// runs out and was last renewed; another run's, which took it over; or gone,
// the run or a person having let the claim go.
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
