// Claims on work items, each a ref of its own, apart from the work branch:
// `refs/chernabog/claims/<item>` (`issue-12`, `pr-73`), pointing at a commit
// with an empty tree whose message says whose run holds it. Creating a ref is
// the one write GitHub refuses to a second writer, so whoever creates it
// holds the item. Releasing it deletes only the ref; the work branch and any
// pull request stay. Labels, assignees and the claim comment are how a person
// sees a claim, written after it is won.
//
// A claim is a lease: its commit says when it expires (Expires-At), and the
// daemon renews the leases of its runs in flight before then. Each claim
// commit after the first has the one it replaces as its parent. Replacing one,
// by a renewal or by a takeover of an expired one, first creates
// `refs/chernabog/leases/<item>/<sha replaced>`, so exactly one writer
// replaces each claim commit: GitHub checks no fast-forward outside
// refs/heads/, and a create is the one write it refuses a second writer. The
// winner then points the claim ref at its commit and deletes the lease ref; a
// reader that finds a lease ref follows it, since a writer may have stopped in
// between. A reader that read the claim ref before the winner moved it, and
// asks only after its lease ref is gone, could still replace the old commit:
// a window of a few requests, which the run that loses sees on its next write.

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type GitHubError } from "./errors.ts";
import { activity } from "./flow.ts";
import * as Markers from "./run-markers.ts";
import { GitHub, type RefCommit, Run } from "./services.ts";

// Git's empty tree, which GitHub has in every repo.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const TITLE = "chernabog claim";

// The claim on an issue, on a pull request, and on an epic, whose run works through its tasks.
export const issue = (number: number) => `issue-${number}`;
export const pullRequest = (number: number) => `pr-${number}`;
export const epic = (number: number) => `epic-${number}`;

export const refFor = (item: string) => `refs/chernabog/claims/${item}`;

// The ref whose creation wins the right to replace the claim commit `sha` on `item`.
export const leaseRefFor = (item: string, sha: string) => `refs/chernabog/leases/${item}/${sha}`;

// How long a claim lasts unless its run's daemon renews it, when the run
// doesn't say (Run's leaseTtl): long enough to cover a machine asleep
// overnight, and far longer than any clock skew between two machines.
export const DEFAULT_LEASE_TTL = Duration.hours(12);

// The work branch a run on an issue makes, which the daemon cleans up after it.
export const branchFor = (number: number) => `auto/issue-${number}`;

// Whose run holds a claim. The commit says nothing about the machine: it is
// as public as the repo.
export type Holder = {
  readonly runId: string;
  readonly persona: string;
  readonly flow: string;
  readonly claimedAt: string;
  readonly withPerson: boolean;
  // When the lease runs out unless it is renewed; a claim from before leases has none, and never expires.
  readonly expiresAt?: string;
  // When the daemon last renewed it; none before its first renewal.
  readonly renewedAt?: string;
  // The run whose expired lease this run took over.
  readonly takenOverFrom?: string;
};

const trailer = (name: string, value: Option.Option<string>) =>
  Option.toArray(Option.map(value, (found) => `${name}: ${found}`));

export const messageOf = (holder: Holder) =>
  [
    TITLE,
    "",
    `Run: ${holder.runId}`,
    `Persona: ${holder.persona}`,
    `Flow: ${holder.flow}`,
    `Claimed-At: ${holder.claimedAt}`,
    ...Option.toArray(Option.liftPredicate("With-Person: true", () => holder.withPerson)),
    ...trailer("Expires-At", Option.fromUndefinedOr(holder.expiresAt)),
    ...trailer("Renewed-At", Option.fromUndefinedOr(holder.renewedAt)),
    ...trailer("Taken-Over-From", Option.fromUndefinedOr(holder.takenOverFrom)),
  ].join("\n");

// An optional field from a trailer that is there, else nothing.
const optional = <A extends object>(value: Option.Option<string>, field: (found: string) => A) =>
  Option.match(value, { onNone: () => ({}), onSome: field });

const TRAILER = /^([A-Za-z-]+): (.*)$/;

// The holder a claim commit's message names; none for a message that isn't a claim's.
export const holderOf = (message: string): Option.Option<Holder> => {
  const lines = message.split("\n");

  if (lines[0]?.trim() !== TITLE) {
    return Option.none();
  }

  const trailers = new Map(
    lines.flatMap((line) =>
      Option.toArray(
        Option.map(
          Option.fromNullishOr(TRAILER.exec(line.trim())),
          (match) => [match[1], match[2]] as const,
        ),
      ),
    ),
  );

  return Option.map(Option.fromUndefinedOr(trailers.get("Run")), (runId) => ({
    runId,
    persona: trailers.get("Persona") ?? "",
    flow: trailers.get("Flow") ?? "",
    claimedAt: trailers.get("Claimed-At") ?? "",
    withPerson: trailers.get("With-Person") === "true",
    ...optional(Option.fromUndefinedOr(trailers.get("Expires-At")), (expiresAt) => ({ expiresAt })),
    ...optional(Option.fromUndefinedOr(trailers.get("Renewed-At")), (renewedAt) => ({ renewedAt })),
    ...optional(Option.fromUndefinedOr(trailers.get("Taken-Over-From")), (takenOverFrom) => ({
      takenOverFrom,
    })),
  }));
};

// A claim as it stands: its commit, and whose run it names.
export type Claim = { readonly sha: string; readonly holder: Holder };

// Lease refs a reader follows before it takes the claim commit it has as current.
const MAX_HOPS = 8;

// The claim commit that replaced `at`, and the ones after it: a writer that
// won a lease ref but stopped before moving the claim ref is finished for.
const follow = (
  github: GitHub["Service"],
  item: string,
  at: RefCommit,
  hops: number,
): Effect.Effect<RefCommit, GitHubError> => {
  if (hops >= MAX_HOPS) {
    return Effect.succeed(at);
  }

  return github.ref(leaseRefFor(item, at.sha)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(at),
        onSome: (next) =>
          github
            .updateRef(refFor(item), next.sha)
            .pipe(
              Effect.andThen(github.deleteRef(leaseRefFor(item, at.sha))),
              Effect.ignore,
              Effect.andThen(follow(github, item, next, hops + 1)),
            ),
      }),
    ),
  );
};

// The claim on `item` as it stands, lease refs followed: none when nobody holds it.
export const current = (item: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const head = yield* github.ref(refFor(item));

    if (Option.isNone(head)) {
      return Option.none<Claim>();
    }

    const at = yield* follow(github, item, head.value, 0);

    return Option.map(holderOf(at.message), (found): Claim => ({ sha: at.sha, holder: found }));
  });

// Who holds the claim on `item`: none when nobody does. An expired lease still names its holder.
export const holder = (item: string) =>
  current(item).pipe(Effect.map(Option.map((claim) => claim.holder)));

// When a claim's lease runs out; none for a claim from before leases.
export const expiresAt = (found: Holder) =>
  Option.flatMap(Option.fromUndefinedOr(found.expiresAt), (at) =>
    Option.map(DateTime.make(at), DateTime.toUtc),
  );

// Whether a claim's lease ran out by `now`: its run's daemon didn't renew it
// in time, so another run may take the item over.
export const expired = (found: Holder, now: DateTime.Utc) =>
  Option.exists(expiresAt(found), (at) => DateTime.isLessThanOrEqualTo(at, now));

// Who holds the claim on `item` with a lease that hasn't run out: none when
// nobody does, or the holder's lease expired.
export const liveHolder = (item: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;

    return Option.filter(yield* holder(item), (found) => !expired(found, now));
  });

const leaseEnd = (now: DateTime.Utc, ttl: Duration.Duration) =>
  DateTime.formatIso(DateTime.addDuration(now, ttl));

// Replaces the claim commit `from` with one naming `next`, if no other writer
// replaced it first; whether this one did.
const replace = (item: string, from: Claim, next: Holder) =>
  Effect.gen(function* () {
    const github = yield* GitHub;

    const sha = yield* github.createCommit({
      message: messageOf(next),
      tree: EMPTY_TREE,
      parents: [from.sha],
    });

    if ((yield* github.createRef(leaseRefFor(item, from.sha), sha)) === "already-exists") {
      return false;
    }

    yield* github.updateRef(refFor(item), sha);
    yield* github.deleteRef(leaseRefFor(item, from.sha));

    return true;
  });

export type Renewal =
  | { readonly status: "renewed"; readonly expiresAt: string }
  // Another run took the item over, or let it go after it did.
  | { readonly status: "lost"; readonly holder: Option.Option<Holder> }
  // Nobody holds the claim: the run let it go, or a person deleted it.
  | { readonly status: "released" };

// Renews the lease of `runId`'s claim on `item` for `ttl` from now, unless
// another run took it over first: then the run has lost the item, and must
// stop before anything another person or run sees.
export const renew = (
  item: string,
  runId: string,
  ttl: Duration.Duration,
): Effect.Effect<Renewal, GitHubError, GitHub> =>
  Effect.gen(function* () {
    const found = yield* current(item);

    if (Option.isNone(found)) {
      return { status: "released" } satisfies Renewal;
    }

    if (found.value.holder.runId !== runId) {
      return { status: "lost", holder: Option.some(found.value.holder) } satisfies Renewal;
    }

    const now = yield* DateTime.now;
    const expiry = leaseEnd(now, ttl);

    const next: Holder = {
      ...found.value.holder,
      renewedAt: DateTime.formatIso(now),
      expiresAt: expiry,
    };

    if (yield* replace(item, found.value, next)) {
      return { status: "renewed", expiresAt: expiry } satisfies Renewal;
    }

    return { status: "lost", holder: yield* holder(item) } satisfies Renewal;
  });

export type Holding =
  { readonly held: true } | { readonly held: false; readonly holder: Option.Option<Holder> };

// Whether the claim on `item` still names `runId`: the check a run makes
// before anything another person or run sees. None holding it is not held.
export const holds = (item: string, runId: string) =>
  holder(item).pipe(
    Effect.map((found): Holding => {
      if (Option.exists(found, (named) => named.runId === runId)) {
        return { held: true };
      }

      return { held: false, holder: found };
    }),
  );

// Lets go of the claim on `item` if `runId` holds it, and says whether it did.
// A claim another run holds is left to it.
export const releaseFor = (item: string, runId: string) =>
  Effect.gen(function* () {
    const held = yield* holder(item);

    if (!Option.exists(held, (found) => found.runId === runId)) {
      return false;
    }

    yield* (yield* GitHub).deleteRef(refFor(item));

    return true;
  });

// The claim ref, as a marker: acquire holds it, so the engine lets the claim
// go however the run ends, cancelled or superseded included. Released only
// while the run named holds it.
export const refMarker = Markers.define(
  "chernabog/claim-ref",
  Schema.Struct({ item: Schema.String, runId: Schema.String }),
  (args) => releaseFor(args.item, args.runId).pipe(Effect.asVoid),
);

export type AcquireOptions = {
  // A person works on the item in the run, on the hybrid path.
  readonly withPerson?: boolean;
};

export type Acquired =
  // The run whose expired lease this run took over, if it did.
  | { readonly acquired: true; readonly takenOver: Option.Option<Holder> }
  | { readonly acquired: false; readonly holder: Option.Option<Holder> };

// How long a run's claims last before its daemon renews them.
const leaseTtlOf = (run: Run["Service"]) =>
  Option.match(Option.fromUndefinedOr(run.leaseTtl), {
    onNone: () => DEFAULT_LEASE_TTL,
    onSome: Duration.millis,
  });

// Claims `item` for this run, or says who holds it. A claim whose lease
// expired is taken over, by a commit on top of it: of every run that tries,
// and the holder renewing, exactly one wins. Safe to repeat: a run that
// already holds the claim keeps it.
export const acquire = (item: string, options: AcquireOptions = {}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const run = yield* Run;
    const now = yield* DateTime.now;

    const mine: Holder = {
      runId: run.runId,
      persona: yield* github.login,
      flow: run.flow,
      claimedAt: DateTime.formatIso(now),
      withPerson: options.withPerson === true,
      expiresAt: leaseEnd(now, leaseTtlOf(run)),
    };

    const sha = yield* github.createCommit({
      message: messageOf(mine),
      tree: EMPTY_TREE,
      parents: [],
    });

    // Held once the claim is the run's, and so before anything else this run
    // does, so the engine lets it go however the run ends. A crash just before
    // leaves a claim no run holds, which its lease ends; a run that resumes
    // finds the claim its own, and holds it then.
    const won = (takenOver: Option.Option<Holder>) =>
      Markers.hold(refMarker, { item, runId: run.runId }).pipe(
        Effect.as({ acquired: true, takenOver } satisfies Acquired),
      );

    if ((yield* github.createRef(refFor(item), sha)) === "created") {
      return yield* won(Option.none());
    }

    const found = yield* current(item);

    if (Option.exists(found, (claim) => claim.holder.runId === run.runId)) {
      return yield* won(Option.none());
    }

    const lapsed = Option.filter(found, (claim) => expired(claim.holder, now));

    if (
      Option.isSome(lapsed) &&
      (yield* replace(item, lapsed.value, { ...mine, takenOverFrom: lapsed.value.holder.runId }))
    ) {
      return yield* won(Option.some(lapsed.value.holder));
    }

    return {
      acquired: false,
      holder: yield* Option.match(lapsed, {
        onNone: () => Effect.succeed(Option.map(found, (claim) => claim.holder)),
        // Another run took it over first.
        onSome: () => holder(item),
      }),
    } satisfies Acquired;
  });

// Lets go of this run's claim on `item`.
export const release = (item: string) =>
  Run.use((run) =>
    releaseFor(item, run.runId).pipe(
      Effect.tap(() => Markers.forget(refMarker, { item, runId: run.runId })),
    ),
  );

// Lets the claim on `item` go as soon as `effect` ends, as the step
// `release-claim-<item>`, rather than when the engine releases the run's
// markers after it ends. A run waiting on a signal keeps it. acquire's marker
// already guarantees the release; this only makes it sooner.
export const releasing =
  (item: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      // A wait suspends the run by interrupting it; that is not an ending.
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
          return Effect.void;
        }

        return activity(
          `release-claim-${item}`,
          Run.use((run) => Markers.drop(refMarker, { item, runId: run.runId })),
        ).pipe(Effect.ignore);
      }),
    );

// A note for a skip: who holds the claim, as far as its ref says, and until when.
export const describeHolder = (item: string, held: Option.Option<Holder>) =>
  Option.match(held, {
    onNone: () => `${refFor(item)} exists`,
    onSome: (found) =>
      [
        `run ${found.runId} of ${found.flow} holds ${refFor(item)}`,
        ...Option.toArray(
          Option.map(Option.fromUndefinedOr(found.expiresAt), (at) => `its lease runs to ${at}`),
        ),
      ].join(", "),
  });

// Why a run whose claim names another run (or none) stops: it lost the item.
export const describeLoss = (item: string, held: Option.Option<Holder>) =>
  Option.match(held, {
    onNone: () => `its claim on ${item} was taken over, and has been let go since`,
    onSome: (found) => `${found.persona}'s run ${found.runId} of ${found.flow} took ${item} over`,
  });

// What a run that took an item over says on it, for people to read.
export const describeTakeover = (previous: Holder) =>
  [
    `Taken over from ${previous.persona}'s run ${previous.runId}`,
    ...Option.toArray(
      Option.map(
        Option.fromUndefinedOr(previous.expiresAt),
        (at) => `after its lease expired at ${at}`,
      ),
    ),
  ].join(" ") + ".";
