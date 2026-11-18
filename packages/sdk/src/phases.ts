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
  Claims,
  CurrentNode,
  GitHub,
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
    awaitingCi: "awaiting-ci",
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
    awaitingCi: "awaiting-ci",
    // A watch of a merge commit's push CI that parked: post-merge's, not the
    // pull request's own CI, which awaiting-ci is.
    awaitingMergeCi: "awaiting-merge-ci",
    // resolve-conflicts' wait for CI on the merge it pushed, which parked: not
    // awaiting-ci, which is address-review's wait on its own fix. Its data
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
// Gives the record the item holds afterwards; record gives nothing, for an
// activity that journals no result.
export const recording = (
  item: string,
  to: string,
  data?: { readonly [key: string]: Json },
  options: { readonly again?: boolean } = {},
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
        (found) => found.phase === phase && (options.again !== true || found.by === by),
      );

      if (Option.isSome(there)) {
        return there.value;
      }

      const from = Option.map(current, (found) => found.phase);

      const transition = Option.match(carried, {
        onNone: () => ({ from, to: phase, by }),
        onSome: (found) => ({ from, to: phase, by, data: found }),
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
  options: { readonly again?: boolean } = {},
) => Effect.asVoid(recording(item, to, data, options));

// Every item's record, in one read, for a source that looks at every open item.
export const records = Progress.use((progress) => progress.readAll);

// The record of one item, for a run that reads only its own.
export const current = (item: string) => Progress.use((progress) => progress.read(item));

// The record of `item` among `all`, from records.
export const recordOf = (all: ReadonlyMap<string, PhaseRecord>, item: string) =>
  Option.fromUndefinedOr(all.get(item));

// Whether `found` holds one of `phases`.
export const holds = (found: PhaseRecord, phases: ReadonlyArray<Phase>) =>
  phases.some((phase) => phase === found.phase);

// Moves `item` from the record a source read, `found`, to `to`, from a fact
// on GitHub that no run was there to record, such as a person's review
// (docs/run-progress/handoffs.md, question 5). Outside a run, so `by` names
// the source. Returns the record the item holds afterwards: the one written,
// or, when another writer moved it first, the one it moved it to.
export const reconcile = (item: string, found: Option.Option<PhaseRecord>, to: Phase, by: string) =>
  Progress.use((progress) =>
    progress
      .advance(item, {
        from: Option.map(found, (held) => held.phase),
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
