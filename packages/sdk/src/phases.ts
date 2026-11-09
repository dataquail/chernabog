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
  type NodeAt,
  Phase as CorePhase,
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
    proposed: "proposed",
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
  },
  epic: { waiting: "waiting", finished: "finished" },
} as const;

type PhasesOf<Kind extends keyof typeof PHASES> =
  (typeof PHASES)[Kind][keyof (typeof PHASES)[Kind]];

// One of the SDK's phases.
export type Phase = PhasesOf<"issue"> | PhasesOf<"pullRequest"> | PhasesOf<"epic">;

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

// The times a run's write reads the item again after another writer moved it.
const RECORD_TRIES = 3;

// Records that `item` has reached `to`, as the run: from whatever phase it
// holds now, and nothing when it is there already, so a source that
// reconciled the same fact first, or a replay, writes no second record. A
// handoff happens whatever the item held before it, so a lost race reads
// again and moves on from what it finds. Call it inside the activity that
// makes the handoff, so a replay of a finished one doesn't write again.
export const record = (item: string, to: string) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const run = yield* Run;
    const phase = asPhase(to);
    const by = asWriter(run.runId);

    for (let tries = 1; ; tries++) {
      const current = yield* progress.read(item);

      if (Option.exists(current, (found) => found.phase === phase)) {
        return;
      }

      const from = Option.map(current, (found) => found.phase);

      const moved = yield* progress.advance(item, { from, to: phase, by }).pipe(
        Effect.as(false),
        Effect.catchTag("PhaseMoved", (lost) => {
          if (tries < RECORD_TRIES) {
            return Effect.succeed(true);
          }

          return Effect.fail(new ProgressError({ message: lost.message }));
        }),
      );

      if (!moved) {
        return;
      }
    }
  });

// Every item's record, in one read, for a source that looks at every open item.
export const records = Progress.use((progress) => progress.readAll);

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
