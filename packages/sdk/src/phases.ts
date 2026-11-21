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
  type WorkItem,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
    awaitingCi: "awaiting-ci",
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
    awaitingCi: "awaiting-ci",
    // A watch of a merge commit's push CI that parked: post-merge's, not the
    // pull request's own CI, which awaiting-ci is.
    awaitingMergeCi: "awaiting-merge-ci",
    // resolve-conflicts' wait for CI on the merge it pushed, which parked: not
    // awaiting-ci, which is address-review's wait on its own fix. Its data
    // keeps the review phase it parked over, which the run that takes it up
    // records again (Conflict.waitForCi).
    awaitingConflictCi: "awaiting-conflict-ci",
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

// The phase a CI job's run records before it parks on its pull request's CI
// (Implement.waitForCi's park): awaiting-ci for the first round, then
// awaiting-ci-2 once one fix of red CI was pushed, and so on, so the job that
// resumes it counts ciRounds on from there.
export const awaitingCi = (round: number) => {
  if (round <= 1) {
    return PHASES.issue.awaitingCi;
  }

  return `${PHASES.issue.awaitingCi}-${round}`;
};

const AWAITING_CI = /^awaiting-ci(?:-(\d+))?$/;

// The round of CI a phase awaitingCi recorded waits on; none for any other phase.
export const ciRoundOf = (phase: string): Option.Option<number> =>
  Option.map(Option.fromNullOr(AWAITING_CI.exec(phase)), (found) =>
    Option.match(Option.fromUndefinedOr(found[1]), {
      onNone: () => 1,
      onSome: Number,
    }),
  );

// The phase resolve-conflicts records before it parks on CI for the merge it
// pushed, by round, as awaitingCi does: awaiting-conflict-ci, then
// awaiting-conflict-ci-2 once one fix of red CI was pushed.
export const conflictCi = (round: number) => {
  if (round <= 1) {
    return PHASES.pullRequest.awaitingConflictCi;
  }

  return `${PHASES.pullRequest.awaitingConflictCi}-${round}`;
};

const AWAITING_CONFLICT_CI = /^awaiting-conflict-ci(?:-(\d+))?$/;

// The round of CI a phase conflictCi recorded waits on; none for any other phase.
export const conflictCiRoundOf = (phase: string): Option.Option<number> =>
  Option.map(Option.fromNullOr(AWAITING_CONFLICT_CI.exec(phase)), (found) =>
    Option.match(Option.fromUndefinedOr(found[1]), {
      onNone: () => 1,
      onSome: Number,
    }),
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
export const declaredAs = (phase: string) => {
  if (Option.isSome(ciRoundOf(phase))) {
    return PHASES.issue.awaitingCi;
  }

  if (Option.isSome(conflictCiRoundOf(phase))) {
    return PHASES.pullRequest.awaitingConflictCi;
  }

  return phase;
};

// The one catalogue of the SDK's phases, keyed by phase name: the kinds of
// item each is a phase of (awaiting-ci is an issue's and a pull request's).
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
// round's, not the round it first parked in.
// Gives the record the item holds afterwards; record gives nothing, for an
// activity that journals no result.
export const recording = (
  item: string,
  to: string,
  data?: { readonly [key: string]: Json },
  options: { readonly again?: boolean; readonly always?: boolean } = {},
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
      const transition = Option.match(carried, {
        onNone: () => ({ from: current, to: phase, by }),
        onSome: (found) => ({ from: current, to: phase, by, data: found }),
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
  options: { readonly again?: boolean; readonly always?: boolean } = {},
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
export const Checking = Context.Reference<
  Option.Option<{
    readonly check: (item: string, record: PhaseRecord) => Option.Option<Anomaly>;
    readonly noted: Map<string, Anomaly>;
  }>
>("@chernabog/sdk/Phases/Checking", { defaultValue: () => Option.none() });

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
// when it began, which every park's record keeps.
export type Parking = {
  readonly step: string;
  readonly item: string;
  readonly phase: string;
  readonly data: { readonly [key: string]: Json };
  readonly keeps?: (found: PhaseRecord) => boolean;
  readonly timeout?: Duration.Duration;
};

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
      yield* record(parking.item, parking.phase, { since, ...parking.data }, { always: true });

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

// Who records that a person handed an item back (handedBack).
export const HANDED_BACK_BY = "observer:handed-back";

// The roles on the repo whose say a label's removal counts as: GitHub's
// write access and above.
const TRUSTED_PERMISSIONS = ["admin", "maintain", "write"];

const LabelEvents = Schema.Array(
  Schema.Struct({
    event: Schema.String,
    label: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
    actor: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  }),
);

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
        () => [],
      );

      for (const found of listed) {
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
