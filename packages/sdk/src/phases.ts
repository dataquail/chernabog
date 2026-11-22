// The phases an item reaches between runs, by kind of item, and what the
// catalogue declares of them: the phases each source reads and each block
// records (docs/run-progress/handoffs.md, questions 1 and 8). A phase is
// written by one flow and read by another, so these declarations are what the
// check across a repo's flows goes by (Compose.phaseGaps).
//
// Unlike labels, a repo can't rename these: no person reads or applies them.
// A team's own phases are strings it chooses, recorded with progress.advance.

import {
  activity,
  awaitSignal,
  Claims,
  CurrentNode,
  GitHub,
  isPhaseData,
  type Json,
  type NodeAt,
  Phase as CorePhase,
  PhaseData,
  type PhaseRecord,
  PhaseWriter,
  Progress,
  ProgressError,
  Repo,
  Run,
  SessionMarker,
  type WorkItem,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as Settings from "./settings.ts";

// What a phase is kept for. These are the names claim refs already use.
export type ItemKind = "issue" | "pull-request" | "epic";

export const ITEM_KINDS: ReadonlyArray<ItemKind> = ["issue", "pull-request", "epic"];

export const PHASES = {
  issue: {
    handedOff: "handed-off",
    askedQuestions: "asked-questions",
    awaitingReady: "awaiting-ready",
    readyTimedOut: "ready-timed-out",
    // implement's wait for CI on the pull request its run opened, which parked.
    awaitingCi: "awaiting-ci",
    // implement's wait for CI on a pull request it adopted, which parked: not
    // awaiting-ci, so the phase alone says the run that takes it up hands the
    // pull request off as an adopted one. Its data keeps the pull request,
    // which isn't on the issue's branch.
    awaitingAdoptedCi: "awaiting-adopted-ci",
    // An epic's task whose lane ended on its pull request's pending CI (audit
    // W7): a lane can't park on its own, so the epic's run takes the task up
    // once CI settles (Epic.takeUpCi). Not awaiting-ci, which implement's
    // source resumes as its own. Its data keeps the pull request, the lane,
    // its branch and base, the round of CI and when that round began.
    awaitingTaskCi: "awaiting-task-ci",
    proposed: "proposed",
    planHandedBack: "plan-handed-back",
    becameEpic: "became-epic",
    // With a person (ADR 21, decision 1): handed to one, or a plan's task
    // for one; auto:needs-human is this record's projection.
    withPerson: "with-person",
    // A trusted person removed auto:needs-human from an item with-person: their
    // intent, which observer:handed-back records.
    handedBack: "handed-back",
  },
  pullRequest: {
    reviewAsked: "review-asked",
    changesAsked: "changes-asked",
    reviewAskedAgain: "review-asked-again",
    approved: "approved",
    mergeHeld: "merge-held",
    readyForPerson: "ready-for-person",
    draft: "draft",
    watched: "watched",
    // address-review's wait for CI on the fix it pushed, which parked: not
    // the issue's awaiting-ci, which is implement's.
    awaitingFixCi: "awaiting-fix-ci",
    // A watch of a merge commit's push CI that parked: post-merge's, not the
    // pull request's own CI, which awaiting-fix-ci is.
    awaitingMergeCi: "awaiting-merge-ci",
    // resolve-conflicts' wait for CI on the merge it pushed, which parked: not
    // awaiting-fix-ci, which is address-review's wait on its own fix. Its data
    // keeps the review phase it parked over, which the run that takes it up
    // records again (Conflict.waitForCi).
    awaitingConflictCi: "awaiting-conflict-ci",
    // An epic layer's refresh whose CI was still pending (audit W7): the
    // epic's run takes it up once CI settles (Epic.takeUpRefreshes), then
    // records again the review phase it was written over, which a blob its
    // data names keeps beside what the refresh says to a reviewer asked again.
    awaitingRefreshCi: "awaiting-refresh-ci",
    withPerson: "with-person",
    handedBack: "handed-back",
  },
  epic: {
    waiting: "waiting",
    finished: "finished",
    withPerson: "with-person",
    handedBack: "handed-back",
  },
} as const;

type PhasesOf<Kind extends keyof typeof PHASES> =
  (typeof PHASES)[Kind][keyof (typeof PHASES)[Kind]];

// One of the SDK's phases.
export type Phase = PhasesOf<"issue"> | PhasesOf<"pullRequest"> | PhasesOf<"epic">;

// The waits for CI whose phase carries the round it waits on: the first
// round's phase, then `-2` once one fix of red CI was pushed, and so on
// (awaiting-ci, awaiting-ci-2), so the run that takes the wait up counts
// ciRounds on from there. Each is a park site's own (PARKS).
export const ROUNDED = [
  PHASES.issue.awaitingCi,
  PHASES.issue.awaitingAdoptedCi,
  PHASES.pullRequest.awaitingFixCi,
  PHASES.pullRequest.awaitingConflictCi,
] as const;

export type Rounded = (typeof ROUNDED)[number];

// The phase a wait for CI at `phase`'s site records in `round`.
export const inRound = (phase: Rounded, round: number) => {
  if (round <= 1) {
    return phase;
  }

  return `${phase}-${round}`;
};

const ROUND = /^(.*?)(?:-(\d+))?$/;

// The round of `phase`'s wait for CI that `recorded` waits on: 1 for the
// phase itself, n for `phase-n`; none for any other phase.
export const roundOf = (phase: Rounded, recorded: string): Option.Option<number> =>
  Option.flatMap(Option.fromNullOr(ROUND.exec(recorded)), (found) =>
    Option.map(
      Option.liftPredicate(found[1], (base) => base === phase),
      () =>
        Option.match(Option.fromUndefinedOr(found[2]), {
          onNone: () => 1,
          onSome: Number,
        }),
    ),
  );

// The wait for CI `recorded` is a round of, and the round; none for a phase
// that isn't one.
export const roundedOf = (
  recorded: string,
): Option.Option<{ readonly phase: Rounded; readonly round: number }> =>
  Arr.findFirst(ROUNDED, (phase) =>
    Option.map(roundOf(phase, recorded), (round) => ({ phase, round })),
  );

// What a source reads of an item with no record yet.
export const NO_RECORD = "none";

// The SDK's phases of each kind of item.
export const phasesOf = (item: ItemKind): ReadonlyArray<string> =>
  Object.values(
    { issue: PHASES.issue, "pull-request": PHASES.pullRequest, epic: PHASES.epic }[item],
  );

// A phase as the catalogue keys it: a later round's wait for CI
// (`awaiting-ci-2`, `awaiting-conflict-ci-3`) is its first round's phase.
export const declaredAs = (phase: string): string =>
  Option.match(roundedOf(phase), {
    onNone: () => phase,
    onSome: (found) => found.phase,
  });

// The one catalogue of the SDK's phases, keyed by phase name: the kinds of
// item each is a phase of.
// The ledger's check of a run's record and the compiler's check of a phase a
// document names both go by it (misplacedOn), so they can't disagree.
const CATALOGUE: ReadonlyMap<string, ReadonlyArray<ItemKind>> = new Map(
  Arr.dedupe(ITEM_KINDS.flatMap(phasesOf)).map((phase) => [
    phase,
    ITEM_KINDS.filter((kind) => phasesOf(kind).includes(phase)),
  ]),
);

const ARTICLES = {
  issue: "an",
  "pull-request": "a",
  epic: "an",
} as const satisfies { readonly [kind in ItemKind]: string };

// Why `phase` can't be recorded on an item of `kind`: it is one of the SDK's
// phases, of other kinds of item only, such as an epic's `waiting` on a pull
// request. None for a phase of the kind's, and for a team's own, which the
// repo names.
export const misplacedOn = (kind: ItemKind, phase: string): Option.Option<string> =>
  Option.flatMap(Option.fromUndefinedOr(CATALOGUE.get(declaredAs(phase))), (kinds) =>
    Option.liftPredicate(
      `${phase} isn't a phase of ${ARTICLES[kind]} ${kind}`,
      () => !kinds.includes(kind),
    ),
  );

// Every place a run parks (ADR 21, decision 4): the wait, the kind of item
// its record is kept for, and the phase it records there, a phase of its own.
// A park is a phase boundary, so the phase alone says where the run that
// takes the item up starts, and `data` keeps only the facts it needs. No two
// sites share a phase, across recipes and documents: a recipe's wait and the
// block that is its document's form are one site.
export type ParkSite = {
  readonly site: string;
  readonly item: ItemKind;
  readonly phase: Phase;
};

export const PARKS: ReadonlyArray<ParkSite> = [
  {
    site: "implement: CI on the pull request its run opened (ci.waitAndFix)",
    item: "issue",
    phase: PHASES.issue.awaitingCi,
  },
  {
    site: "implement: CI on a pull request it adopted (ci.waitPreparing)",
    item: "issue",
    phase: PHASES.issue.awaitingAdoptedCi,
  },
  {
    site: "implement: an adopted draft its author marks ready (pr.awaitReady)",
    item: "issue",
    phase: PHASES.issue.awaitingReady,
  },
  {
    site: "plan: a person's answer to the plan (plan.awaitAnswer)",
    item: "issue",
    phase: PHASES.issue.proposed,
  },
  {
    site: "address-review: CI on the fix it pushed (author.waitForCi)",
    item: "pull-request",
    phase: PHASES.pullRequest.awaitingFixCi,
  },
  {
    site: "resolve-conflicts: CI on the merge it pushed (conflict.waitForCi)",
    item: "pull-request",
    phase: PHASES.pullRequest.awaitingConflictCi,
  },
  {
    site: "post-merge: push CI on the merge commit (merged.awaitCi)",
    item: "pull-request",
    phase: PHASES.pullRequest.awaitingMergeCi,
  },
  {
    site: "review, re-review: a merge held for a red base (pr.land)",
    item: "pull-request",
    phase: PHASES.pullRequest.mergeHeld,
  },
  {
    site: "epic: the epic between rounds (epic.park)",
    item: "epic",
    phase: PHASES.epic.waiting,
  },
];

// The item a run on each subject works on, which a team's own
// progress.advance step records its phase on. Four subjects are one pull
// request, seen by different flows.
export const SUBJECT_ITEMS = {
  issue: "issue",
  spec: "issue",
  "pull-request": "pull-request",
  "changes-asked": "pull-request",
  conflict: "pull-request",
  merged: "pull-request",
  epic: "epic",
} as const satisfies { readonly [subject: string]: ItemKind };

// One phase a block may record on its way out.
export type Recorded = {
  readonly item: ItemKind;
  readonly phase: Phase;
  // Recorded only when the block comes to this outcome; left out: on any
  // ending that goes on.
  readonly on?: string;
};

// The phases whose items a source finds, or a wake finds parked runs by.
// NO_RECORD for an item with no record yet.
export type Reading = {
  readonly item: ItemKind;
  readonly phases: ReadonlyArray<Phase | typeof NO_RECORD>;
};

// A phase a source moves an item to from what it reads on GitHub, such as a
// person's review, each from the phases it moves on from (question 5).
export type Reconciling = {
  readonly item: ItemKind;
  readonly from: ReadonlyArray<Phase | typeof NO_RECORD>;
  readonly to: Phase;
};

// What a source declares of phases.
export type SourceProgress = {
  readonly reads: ReadonlyArray<Reading>;
  readonly reconciles?: ReadonlyArray<Reconciling>;
};

// As a phase is written: lower-case words joined by hyphens.
export const PHASE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Reading and recording an item's phase, through core's Progress port, for the
// blocks that own a handoff and the sources that read one. Both a document's
// blocks and a recipe's own code call these, so the two record and read alike.

// The item a phase is kept for, named as its claim is.
export const issueItem = (issue: number) => Claims.issue(issue);
export const pullRequestItem = (pullRequest: number) => Claims.pullRequest(pullRequest);

const asPhase = Schema.decodeSync(CorePhase);
const asWriter = Schema.decodeSync(PhaseWriter);
const asData = Schema.decodeSync(PhaseData);

// The times a run's write reads the item again after another writer moved it.
const RECORD_TRIES = 3;

// The latest review of a pull request, as its record keeps it under `review`
// (ADR 21, decision 7): the head it saw, who gave it, its round and verdict,
// and the session it ran in, so a re-review resumes it. The merge gate, a
// re-review and address-review read it here, not from the review's comment,
// which is for people.
export const Reviewed = Schema.Struct({
  sha: Schema.String,
  reviewer: Schema.String,
  round: Schema.Finite,
  verdict: Schema.Literals(["approve", "request-changes"]),
  sessionId: Schema.optionalKey(Schema.String),
  adapter: Schema.optionalKey(Schema.String),
});

export type Reviewed = typeof Reviewed.Type;

const REVIEW = "review";

const ReviewedData = Schema.Struct({ [REVIEW]: Reviewed });

// The review `found` keeps; none for a record that keeps none.
export const reviewOf = (found: PhaseRecord): Option.Option<Reviewed> =>
  Option.map(
    Option.flatMap(found.data, Schema.decodeUnknownOption(ReviewedData)),
    (data) => data.review,
  );

// A review as record data, for review.round to record and backfill to copy.
export const reviewData = (review: Reviewed) => ({
  [REVIEW]: Schema.encodeSync(Reviewed)(review),
});

type Data = { readonly [key: string]: Json };

// `data` with the review `from` keeps, unless `data` names one: a pull
// request's latest review stays in its record through every phase after it
// (merge-held, review-asked-again, a wait on CI), until a review replaces it.
const carryingReview = (from: Option.Option<PhaseRecord>, data: Option.Option<Data>) => {
  if (Option.exists(data, (given) => REVIEW in given)) {
    return data;
  }

  const kept = Option.flatMap(
    Option.flatMap(from, (found) => found.data),
    (found) => Option.fromUndefinedOr(found[REVIEW]),
  );

  return Option.match(kept, {
    onNone: () => data,
    onSome: (review) =>
      // Stryker disable next-line ArrowFunction: { ...undefined } and { ...{} } spread to the same object
      Option.some<Data>({ ...Option.getOrElse(data, (): Data => ({})), [REVIEW]: review }),
  });
};

// Records that `item` has reached `to`, as the run: from whatever phase it
// holds now, and nothing when it is there already, so a source that
// reconciled the same fact first, or a replay, writes no second record. A
// handoff happens whatever the item held before it, so a lost race reads
// again and moves on from what it finds. Call it inside the activity that
// makes the handoff, so a replay of a finished one doesn't write again.
// `data` is what the run that picks the item up next needs from this one, a
// JSON object of at most 4 KB (core's PhaseData); an item already at `to`
// keeps the data it has. A pull request's review (reviewOf) is carried into
// the new record unless `data` names one. `again` writes a fresh record even then, unless this
// run wrote the one there: a wait that starts over, with a new `at` and data.
// `always` writes a fresh record even when this run wrote the one there: a
// wait a run may enter again after a signal woke it, whose data is this
// round's, not the round it first parked in. `blobs` is content too big for
// `data`, written with the record and named in it by hash (Progress.blob).
// Gives the record the item holds afterwards; record gives nothing, for an
// activity that journals no result.
export type RecordOptions = {
  readonly again?: boolean;
  readonly always?: boolean;
  readonly blobs?: ReadonlyArray<Uint8Array | string>;
};

export const recording = (
  item: string,
  to: string,
  data?: { readonly [key: string]: Json },
  options: RecordOptions = {},
) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const run = yield* Run;
    const phase = asPhase(to);
    const by = asWriter(run.runId);

    for (let tries = 1; ; tries++) {
      const current = yield* progress.read(item);
      const carried = Option.map(carryingReview(current, Option.fromUndefinedOr(data)), asData);

      const there = Option.filter(
        current,
        (found) =>
          found.phase === phase &&
          options.always !== true &&
          (options.again !== true || found.by === by),
      );

      if (Option.isSome(there)) {
        return there.value;
      }

      // From the record just read, by version: one another writer moved
      // since is a lost race, which reads again.
      const base = { from: current, to: phase, by, blobs: options.blobs ?? [] };

      const transition = Option.match(carried, {
        onNone: () => base,
        onSome: (found) => ({ ...base, data: found }),
      });

      const written = yield* progress.advance(item, transition).pipe(
        Effect.asSome,
        Effect.catchTag("PhaseMoved", (lost) => {
          if (tries < RECORD_TRIES) {
            return Effect.succeedNone;
          }

          return Effect.fail(new ProgressError({ message: lost.message }));
        }),
      );

      if (Option.isSome(written)) {
        return written.value;
      }
    }
  });

export const record = (
  item: string,
  to: string,
  data?: { readonly [key: string]: Json },
  options: RecordOptions = {},
) => Effect.asVoid(recording(item, to, data, options));

// A record a source won't act on (ADR 21, decision 5): the item's record,
// named by its transition, writer and version, and why it fails the check.
// Plain JSON, as `chernabog progress anomalies` reads it.
export type Anomaly = {
  readonly item: string;
  readonly phase: string;
  readonly from?: string;
  readonly by: string;
  readonly version: string;
  readonly why: string;
};

// The check a source's reads go through, inside a trigger that checks them
// (ledger-check.ts, checking): why a record is an anomaly, if it is, and the
// anomalies its reads found, by item. None outside one, as in a run, which
// reads its own item's record as it is.
// Stryker disable StringLiteral: a reference's key only has to be unique, and no other uses "" (survives a 120 s timeoutMS)
export const Checking = Context.Reference<
  Option.Option<{
    readonly check: (item: string, record: PhaseRecord) => Option.Option<Anomaly>;
    readonly noted: Map<string, Anomaly>;
  }>
>("@chernabog/sdk/Phases/Checking", { defaultValue: () => Option.none() });
// Stryker restore StringLiteral

// `found`, the record of `item`, unless the check finds it an anomaly: then
// none, as if the item had no record, and the anomaly noted for the trigger
// to hold the item by. A source that would write from no record loses the
// compare-and-set to the record that is there, so it writes nothing.
const passing = (item: string, found: PhaseRecord) =>
  Effect.gen(function* () {
    const checking = yield* Checking;

    return Option.match(checking, {
      onNone: () => Option.some(found),
      onSome: (checker) =>
        Option.match(checker.check(item, found), {
          onNone: () => Option.some(found),
          onSome: (anomaly) => {
            checker.noted.set(item, anomaly);

            return Option.none<PhaseRecord>();
          },
        }),
    });
  });

// Every item's record, in one read, for a source that looks at every open
// item. Inside a checking trigger, without the anomalies.
export const records = Effect.gen(function* () {
  const all = yield* Progress.use((progress) => progress.readAll);
  const kept = new Map<string, PhaseRecord>();

  for (const [item, found] of all) {
    for (const passed of Option.toArray(yield* passing(item, found))) {
      kept.set(item, passed);
    }
  }

  const passed: ReadonlyMap<string, PhaseRecord> = kept;

  return passed;
});

// The record of one item, for a run that reads only its own, or a source
// that reads one. Inside a checking trigger, none for an anomaly.
export const current = (item: string) =>
  Effect.flatMap(
    Progress.use((progress) => progress.read(item)),
    Option.match({
      onNone: () => Effect.succeedNone,
      onSome: (found) => passing(item, found),
    }),
  );

// The record of `item` among `all`, from records.
export const recordOf = (all: ReadonlyMap<string, PhaseRecord>, item: string) =>
  Option.fromUndefinedOr(all.get(item));

// A wait on a person or another system (ADR 21, decision 4): the step that
// records it, the item and phase it waits at, and what the record keeps for
// the run that takes it up. `keeps` says whether the record already there is
// this wait, which a run that took it up keeps as it is: by default, any
// record at `phase`. `timeout` is how long the wait may last from `since`,
// when it began, which every park's record keeps. `carries` reads, as the
// record is written, what it carries on from the record there: data, and
// blobs it names by hash (Progress.blob), which only the record that names
// them reads, so a wait that keeps one writes it again.
export type Carried = {
  readonly data: { readonly [key: string]: Json };
  readonly blobs: ReadonlyArray<Uint8Array | string>;
};

export type Parking = {
  readonly step: string;
  readonly item: string;
  readonly phase: string;
  readonly data: { readonly [key: string]: Json };
  readonly keeps?: (found: PhaseRecord) => boolean;
  readonly timeout?: Duration.Duration;
  readonly carries?: Effect.Effect<Carried, ProgressError, Progress>;
};

const NOTHING_CARRIED: Effect.Effect<Carried> = Effect.succeed({ data: {}, blobs: [] });

const Since = Schema.Struct({ since: Schema.String });

// A `since` as long as any, for sizing a record before it's written.
const SINCE_SIZE = DateTime.formatIso(DateTime.makeUnsafe(0));

// Whether `data` fits a park's record, with room for the `since` park adds.
export const fitsAPark = (data: { readonly [key: string]: Json }): data is PhaseData =>
  isPhaseData(data) && isPhaseData({ since: SINCE_SIZE, ...data });

// When the wait a record parked began, by its data's `since`.
export const sinceOf = (data: Option.Option<{ readonly [key: string]: Json }>) =>
  Option.flatMap(Option.flatMap(data, Schema.decodeUnknownOption(Since)), (found) =>
    DateTime.make(found.since),
  );

// Whether a wait that began `since` has run past `timeout` by now.
export const pastSince = (since: Option.Option<DateTime.Utc>, timeout: Duration.Duration) =>
  Effect.map(DateTime.now, (now) =>
    Option.exists(since, (began) =>
      DateTime.isLessThanOrEqualTo(DateTime.addDuration(began, timeout), now),
    ),
  );

const Parked = Schema.Literals(["parked", "timed-out"]);

// Records the wait, as its step, unless the item's record is this wait
// already: a fresh record, with `since` now unless the data says when it
// began. A kept record past its timeout is `timed-out`, and parks no more.
// For a wait that polls rather than park, which still records where it is.
export const recordParking = (parking: Parking) =>
  activity(
    parking.step,
    Effect.gen(function* () {
      const found = Option.filter(
        yield* current(parking.item),
        (there) =>
          there.phase === parking.phase &&
          (Predicate.isUndefined(parking.keeps) || parking.keeps(there)),
      );

      if (Option.isSome(found)) {
        const timeout = Option.fromUndefinedOr(parking.timeout);

        if (
          Option.isSome(timeout) &&
          (yield* pastSince(sinceOf(found.value.data), timeout.value))
        ) {
          return "timed-out" as const;
        }

        return "parked" as const;
      }

      // The item's record isn't this wait, so write it even over one this run
      // wrote: a run a signal woke parks again with its new round's data.
      const since = DateTime.formatIso(yield* DateTime.now);
      const carried = yield* parking.carries ?? NOTHING_CARRIED;

      yield* record(
        parking.item,
        parking.phase,
        { since, ...parking.data, ...carried.data },
        { always: true, blobs: carried.blobs },
      );

      return "parked" as const;
    }),
    Parked,
  );

// The longest a park waits on its signals: a run ends at its park, so its
// timeout never comes; a wait with a deadline gives its own.
const PARKED_AT_MOST = Duration.days(365);

// Parks the run on a wait (ADR 21, decision 4): records it first
// (recordParking), then parks on `signals`, which ends the run, on a daemon
// as in a CI job; a later run takes the item up from the record. The only
// way the SDK and the recipes park, so no run ends at a park without its
// record (the members rule no-bare-park). Gives the signal, "timeout", or
// "timed-out" for a kept wait already past its timeout, which parks no more.
export const park = (parking: Parking, signals: ReadonlyArray<string>, id: string) =>
  recordParking(parking).pipe(
    Effect.filterOrElse(
      (parked) => parked === "timed-out",
      () => awaitSignal(signals, { id, timeout: parking.timeout ?? PARKED_AT_MOST }),
    ),
  );

// Whether `found` holds one of `phases`.
export const holds = (found: PhaseRecord, phases: ReadonlyArray<Phase>) =>
  phases.some((phase) => phase === found.phase);

// Moves `item` from the record a source read, `found`, to `to`, keeping its
// review, only while it is still that record, by version, from a fact
// on GitHub that no run was there to record, such as a person's review
// (docs/run-progress/handoffs.md, question 5). Outside a run, so `by` names
// the source. Returns the record the item holds afterwards: the one written,
// or, when another writer moved it first, the one it moved it to.
export const reconcile = (
  item: string,
  found: Option.Option<PhaseRecord>,
  to: Phase | (string & {}),
  by: string,
  data?: { readonly [key: string]: Json },
) =>
  Progress.use((progress) =>
    progress
      .advance(item, {
        from: found,
        to: asPhase(to),
        by: asWriter(by),
        ...Option.match(carryingReview(found, Option.fromUndefinedOr(data)), {
          // Stryker disable next-line ArrowFunction: { ...undefined } and { ...{} } spread to the same object
          onNone: () => ({}),
          onSome: (carried) => ({ data: asData(carried) }),
        }),
      })
      .pipe(
        Effect.asSome,
        Effect.catchTag("PhaseMoved", () => progress.read(item)),
      ),
  );

// What a record a pull request waits on a review at carries (review-asked,
// draft, ready-for-person): who had reviewed it when it was written, so a
// review asked of one of them later is a review again, not a first (ADR 21,
// decision 3). An adopted pull request a persona reviewed before the
// hand-off is one. Left out when nobody had.
const ReviewedBefore = Schema.Struct({ reviewed: Schema.Array(Schema.String) });

// Whether `found` says `login` had reviewed its pull request when it was
// written; false for a record that says nobody had, or from before records
// said so.
export const reviewedBefore = (found: PhaseRecord, login: string) =>
  Option.exists(Option.flatMap(found.data, Schema.decodeUnknownOption(ReviewedBefore)), (data) =>
    data.reviewed.some((own) => own.toLowerCase() === login.toLowerCase()),
  );

// Who has reviewed the pull request so far, as data for its record
// (reviewedBefore); none when nobody has.
export const reviewersOf = (pullRequest: number) =>
  Effect.map(
    GitHub.use((github) => github.reviews(pullRequest)),
    (reviews) =>
      Option.map(
        Arr.match(Arr.dedupe(reviews.map((review) => review.author)), {
          onEmpty: () => Option.none<ReadonlyArray<string>>(),
          onNonEmpty: (authors) => Option.some<ReadonlyArray<string>>(authors),
        }),
        (reviewed) => ({ reviewed: [...reviewed] }),
      ),
  );

// Records `to` on the pull request, a phase it waits on a review at, with who
// had reviewed it so far (reviewersOf).
export const recordAwaitingReview = (pullRequest: number, to: Phase) =>
  Effect.gen(function* () {
    const reviewed = yield* reviewersOf(pullRequest);

    yield* Option.match(reviewed, {
      onNone: () => record(pullRequestItem(pullRequest), to),
      onSome: (data) => record(pullRequestItem(pullRequest), to, data),
    });
  });

// What an issue's handed-off record carries (ADR 21, decision 7): the pull
// request its progress goes on as, and the agent session that wrote it, which
// address-review resumes (Review.findAuthorSession). The issue's record stays
// at handed-off while the pull request's moves through review, so the session
// outlives every phase of the pull request's. author is left out for a
// session that doesn't fit a record, which a later run finds as none.
const HandedOff = Schema.Struct({ pullRequest: Schema.Finite, author: SessionMarker });

// The data of an issue's handed-off record for `pullRequest`, written by `session`.
export const handedOffData = (
  pullRequest: number,
  session: Option.Option<SessionMarker>,
): { readonly [key: string]: Json } => {
  const bare = { pullRequest };

  return Option.getOrElse(
    Option.filter(
      Option.map(session, (author) => ({ pullRequest, author: { ...author } })),
      isPhaseData,
    ),
    () => bare,
  );
};

// Records the issue handed off as `pullRequest`, with the session that wrote
// it. Again even when the issue is at handed-off already, from an earlier
// pull request: the data is this hand-off's. A replay keeps its own record.
export const recordHandedOff = (
  issue: number,
  pullRequest: number,
  session: Option.Option<SessionMarker>,
) =>
  record(issueItem(issue), PHASES.issue.handedOff, handedOffData(pullRequest, session), {
    again: true,
  });

// Records by when they were written, oldest first.
const byWhen = Order.mapInput(DateTime.Order, (found: { readonly at: DateTime.Utc }) => found.at);

// The session a record among `all` says wrote `pullRequest`: the newest
// handed-off record naming it, by when it was written. None when no record
// does, such as for a pull request no run handed off.
export const authorOf = (all: ReadonlyMap<string, PhaseRecord>, pullRequest: number) => {
  const naming = Array.from(all.values()).flatMap((found) => {
    const data = Option.flatMap(
      Option.filter(found.data, () => found.phase === PHASES.issue.handedOff),
      Schema.decodeUnknownOption(HandedOff),
    );

    return Option.toArray(
      Option.map(
        Option.filter(data, (handed) => handed.pullRequest === pullRequest),
        (handed) => ({ at: found.at, author: handed.author }),
      ),
    );
  });

  return Option.map(Arr.last(Arr.sort(naming, byWhen)), (found) => found.author);
};

// A work item's key for the record an item holds: the item, its phase and
// the record's version shortened as a head SHA is, `pr-7-changes-asked-1a2b3c4`.
// A new record is new work, as a new head is to pr.conflicting.
export const keyFor = (item: string, found: PhaseRecord) =>
  `${item}-${found.phase}-${found.version.slice(0, 7)}`;

const PullRequestWork = Schema.Struct({ pullRequest: Schema.Finite });
const IssueWork = Schema.Struct({ issue: Schema.Finite });

// The item a run on `subject` works on, from its work item: the pull request
// its data names, or the issue, or the epic, whose claim is `epic-N` though
// its work item is the issue's. None for one that names neither.
export const itemOfWork = (subject: string, work: WorkItem): Option.Option<string> =>
  Option.flatMap(
    Option.map(
      Arr.findFirst(Object.entries(SUBJECT_ITEMS), ([name]) => name === subject),
      ([, kind]): ItemKind => kind,
    ),
    (kind) => {
      if (kind === "pull-request") {
        return Option.map(Schema.decodeUnknownOption(PullRequestWork)(work.data), (found) =>
          pullRequestItem(found.pullRequest),
        );
      }

      return Option.map(Schema.decodeUnknownOption(IssueWork)(work.data), (found) => {
        if (kind === "epic") {
          return Claims.epic(found.issue);
        }

        return issueItem(found.issue);
      });
    },
  );

// The item a document's run records a team's own phase on (progress.advance):
// its work item's, as its subject sees it, which Blocks.assemble provides.
// None outside a document's run.
// Stryker disable next-line StringLiteral: a reference's key only has to be unique, and no other uses "" (survives a 120 s timeoutMS)
export const RecordedOn = Context.Reference<Option.Option<string>>("@chernabog/sdk/RecordedOn", {
  defaultValue: () => Option.none(),
});

// The step a progress.advance records in: named by its node in the plan,
// with its round and lane, so each step records once and a replay finds it
// recorded, rather than moving the item back.
const advanceStep = (phase: string, node: Option.Option<NodeAt>) =>
  Option.match(node, {
    onNone: () => `progress-${phase}`,
    onSome: (at) =>
      [
        `progress-${at.id}`,
        ...Option.toArray(Option.map(at.round, (round) => `${round}`)),
        ...Option.toArray(at.lane),
      ].join("-"),
  });

// Records `phase` on the item the document's run works on (RecordedOn), as
// the run, in a step of its own; nothing outside a document's run.
export const advanceRun = (phase: string) =>
  Effect.gen(function* () {
    const step = advanceStep(phase, yield* CurrentNode);

    for (const item of Option.toArray(yield* RecordedOn)) {
      yield* activity(step, record(item, phase));
    }
  });

// With a person (ADR 21, decision 1): why the item went to one, and the phase
// it left, none for an item with no record before. Nothing else of that
// record is kept: a park, a person's included, is a phase boundary (decision
// 4), so what comes after reads the record and the world, never what the run
// before it had.
export const WithPerson = Schema.Struct({
  why: Schema.String,
  from: Schema.OptionFromNullOr(Schema.String),
});

const encodeWithPerson = Schema.encodeSync(WithPerson);

// A with-person record's data as the JSON it is written as.
const encodeAsJson = (said: typeof WithPerson.Type): { readonly [key: string]: Json } =>
  encodeWithPerson(said);

// The longest `why` a with-person record keeps, so it fits a record's 4 KB.
const WHY_SIZE = 1000;

// What a with-person record keeps, as data: `why`, and the phase of the
// record it left.
export const withPersonData = (
  why: string,
  left: Option.Option<PhaseRecord>,
): { readonly [key: string]: Json } =>
  encodeAsJson({
    why: Option.match(
      Option.liftPredicate(why, (told) => told.length > WHY_SIZE),
      {
        onNone: () => why,
        onSome: (told) => `${told.slice(0, WHY_SIZE - 1)}…`,
      },
    ),
    from: Option.map(left, (found) => found.phase),
  });

// The issue or pull request number an item's record is kept for (`issue-12`,
// `pr-7`, `epic-4`, whose epic is issue 4); none for a team's own item.
export const numberOf = (item: string): Option.Option<number> =>
  Option.map(Option.fromNullOr(/^(?:issue|pr|epic)-(\d+)$/.exec(item)), (found) =>
    Number(found[1]),
  );

// Whether a person has the item whose record is `found` (ADR 21, decision 1):
// its record is with-person. A hand-back moves the record on, which releases
// it; auto:needs-human, the record's projection, says nothing either way.
export const isWithPerson = (found: Option.Option<PhaseRecord>) =>
  Option.exists(found, (held) => held.phase === PHASES.issue.withPerson);

// Whether a person has `item`, by its record (isWithPerson), as a source or
// a run reads it (current).
export const withPerson = (item: string) => Effect.map(current(item), isWithPerson);

// Records that `item` is with a person, and why, from whatever phase it
// holds; nothing when it is with one already. Without the label: for an item
// labelled as it is made, such as a plan's human task. Call it inside the
// activity that makes the hand-off, as record.
export const recordWithPerson = (item: string, why: string) =>
  Effect.gen(function* () {
    const left = yield* Progress.use((progress) => progress.read(item));

    yield* record(item, PHASES.issue.withPerson, withPersonData(why, left));
  });

// Hands `item` to a person (ADR 21, decision 1): records with-person, then
// labels its issue or pull request auto:needs-human (the repo's needs-human
// label), the record's projection. The one way the SDK hands an item to a
// person. Call it inside the activity that makes the hand-off, as record.
export const handToPerson = (item: string, why: string) =>
  Effect.gen(function* () {
    yield* recordWithPerson(item, why);

    for (const number of Option.toArray(numberOf(item))) {
      const labels = yield* Settings.labels;
      yield* GitHub.use((github) => github.addLabel(number, labels.needsHuman));
    }
  });

const HandedBackData = Schema.Struct({ from: Schema.optionalKey(Schema.NullOr(Schema.String)) });

// The phase a handed-back record says the item went to the person from; none
// for any other record, or one that came from no phase. Nothing else of that
// phase carries over (ADR 21, decision 4): a flow that takes the item up
// again reads what it needs from GitHub.
export const handedBackFrom = (found: PhaseRecord): Option.Option<string> =>
  Option.flatMap(
    Option.filter(found.data, () => found.phase === PHASES.issue.handedBack),
    (data) =>
      Option.flatMap(Schema.decodeUnknownOption(HandedBackData)(data), (said) =>
        Option.fromNullishOr(said.from),
      ),
  );

// Who records that a person handed an item back (handedBack).
export const HANDED_BACK_BY = "observer:handed-back";

// The roles on the repo whose say a label's removal counts as: GitHub's
// write access and above.
const TRUSTED_PERMISSIONS = ["admin", "maintain", "write"];

const LabelEvents = Schema.Array(
  // Stryker disable next-line ObjectLiteral: Struct({}) passes its input through, so only input of the wrong shape differs
  Schema.Struct({
    event: Schema.String,
    // Stryker disable next-line ObjectLiteral: Struct({}) passes its input through, so only input of the wrong shape differs
    label: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
    // Stryker disable next-line ObjectLiteral: Struct({}) passes its input through, so only input of the wrong shape differs
    actor: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  }),
);

// Stryker disable next-line ObjectLiteral: Struct({}) passes its input through, so only input of the wrong shape differs
const Permission = Schema.Struct({ permission: Schema.String });

// GitHub lists an item's events oldest first, a page at a time.
const EVENTS_PAGE = 100;

// The most pages of events read for one item; past them, the latest removal
// is unknown, so nothing is handed back.
const EVENTS_PAGES = 30;

// Who last removed `label` from the issue or pull request, by all its
// events, every page of them; none when GitHub lists no removal, or more
// events than are read.
const removedBy = (number: number, label: string) =>
  Effect.gen(function* () {
    const { slug } = yield* Repo;
    const github = yield* GitHub;
    let last = Option.none<string>();

    for (let page = 1; page <= EVENTS_PAGES; page++) {
      const listed = Option.getOrElse(
        Schema.decodeUnknownOption(LabelEvents)(
          yield* github.request(
            "GET",
            `/repos/${slug}/issues/${number}/events?per_page=${EVENTS_PAGE}&page=${page}`,
            Option.none(),
          ),
        ),
        // Stryker disable next-line ArrowFunction,ArrayDeclaration: only a malformed page of events fails to decode
        () => [],
      );

      for (const found of listed) {
        // Stryker disable next-line OptionalChaining: GitHub's unlabeled events always carry their label
        if (found.event === "unlabeled" && found.label?.name === label) {
          last = Option.map(Option.fromNullishOr(found.actor), (actor) => actor.login);
        }
      }

      if (listed.length < EVENTS_PAGE) {
        return last;
      }
    }

    return Option.none<string>();
  });

// Whether `login` is one the repo trusts with intent: one of its personas,
// or a person with write access to it.
const trusted = (login: string) =>
  Effect.gen(function* () {
    const { personas, slug } = yield* Repo;

    if (personas.some((own) => own.toLowerCase() === login.toLowerCase())) {
      return true;
    }

    const found = yield* GitHub.use((github) =>
      github.request(
        "GET",
        `/repos/${slug}/collaborators/${encodeURIComponent(login)}/permission`,
        Option.none(),
      ),
    );

    return Option.exists(Schema.decodeUnknownOption(Permission)(found), (said) =>
      TRUSTED_PERMISSIONS.includes(said.permission),
    );
  });

// The open issue or pull request an item's record is kept for: its labels.
// None for one closed, or a team's own item.
const openLabels = (item: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const number = numberOf(item);

    if (Option.isNone(number)) {
      return Option.none<ReadonlyArray<string>>();
    }

    if (item.startsWith(pullRequestItem(0).slice(0, -1))) {
      const pull = yield* github.pullRequest(number.value);

      return Option.liftPredicate(pull.labels, () => pull.state === "open");
    }

    const issue = yield* github.issue(number.value);

    return Option.liftPredicate(issue.labels, () => issue.state !== "closed");
  }).pipe(Effect.catchTag("NotFound", () => Effect.succeedNone));

// An item a person handed back: its with-person record.
export type HandedBack = { readonly item: string; readonly record: PhaseRecord };

// The open items whose record is with-person but whose needs-human label a
// trusted person removed (ADR 21, decision 1): their intent to hand it back.
// A label removed by anyone else, or that GitHub names no remover of, hands
// nothing back.
export const handedBack = Effect.gen(function* () {
  const labels = yield* Settings.labels;
  const found: Array<HandedBack> = [];

  for (const [item, held] of yield* records) {
    if (held.phase !== PHASES.issue.withPerson) {
      continue;
    }

    // One item GitHub fails to answer for is looked at again next tick; the
    // rest, and the trigger, go on.
    const back = yield* Effect.gen(function* () {
      const open = yield* openLabels(item);

      if (Option.isNone(open) || open.value.includes(labels.needsHuman)) {
        return false;
      }

      const number = Option.getOrElse(numberOf(item), () => 0);
      const remover = yield* removedBy(number, labels.needsHuman);

      return Option.isSome(remover) && (yield* trusted(remover.value));
    }).pipe(
      Effect.catchTag("GitHubError", (failed) =>
        Effect.logWarning(
          // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word
          `${item}: can't tell whether a person handed it back: ${failed.message}`,
        ).pipe(Effect.as(false)),
      ),
    );

    if (back) {
      found.push({ item, record: held });
    }
  }

  return found;
});

// Stryker disable next-line ObjectLiteral: Struct({}) passes its input through, so only input of the wrong shape differs
const WithPersonLeft = Schema.Struct({
  from: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

// What a hand-back records (ADR 21, decision 1): handed-back, with the phase
// the item went to the person from as `from`, none for one with no record
// before. Sources act on this record; nothing of the phase it left carries
// over but its name.
const returnOf = (held: PhaseRecord) => {
  const left = Option.getOrElse(
    Option.flatMap(held.data, Schema.decodeUnknownOption(WithPersonLeft)),
    (): typeof WithPersonLeft.Type => ({}),
  );

  return asData({ from: Option.getOrNull(Option.fromNullishOr(left.from)) });
};

// Records, on each item a person handed back (handedBack), as
// observer:handed-back, handed-back (returnOf). Only while the item
// still holds the with-person record read; one another writer moved since
// keeps that writer's record.
export const reconcileHandedBack = Effect.gen(function* () {
  for (const back of yield* handedBack) {
    yield* reconcile(
      back.item,
      Option.some(back.record),
      PHASES.issue.handedBack,
      HANDED_BACK_BY,
      returnOf(back.record),
    );
  }
});
