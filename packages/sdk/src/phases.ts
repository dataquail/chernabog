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
    proposed: "proposed",
    planHandedBack: "plan-handed-back",
    becameEpic: "became-epic",
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
  },
  epic: { waiting: "waiting", finished: "finished" },
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

// Records that `item` has reached `to`, as the run: from whatever phase it
// holds now, and nothing when it is there already, so a source that
// reconciled the same fact first, or a replay, writes no second record. A
// handoff happens whatever the item held before it, so a lost race reads
// again and moves on from what it finds. Call it inside the activity that
// makes the handoff, so a replay of a finished one doesn't write again.
// `data` is what the run that picks the item up next needs from this one, a
// JSON object of at most 4 KB (core's PhaseData); an item already at `to`
// keeps the data it has. `again` writes a fresh record even then, unless this
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
    const carried = Option.map(Option.fromUndefinedOr(data), asData);

    for (let tries = 1; ; tries++) {
      const current = yield* progress.read(item);

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

// Moves `item` from the record a source read, `found`, to `to`, only while it
// is still that record, by version, from a fact
// on GitHub that no run was there to record, such as a person's review
// (docs/run-progress/handoffs.md, question 5). Outside a run, so `by` names
// the source. Returns the record the item holds afterwards: the one written,
// or, when another writer moved it first, the one it moved it to.
export const reconcile = (item: string, found: Option.Option<PhaseRecord>, to: Phase, by: string) =>
  Progress.use((progress) =>
    progress
      .advance(item, {
        from: found,
        to: asPhase(to),
        by: asWriter(by),
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
