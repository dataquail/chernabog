// Blocks: the pieces a flow document is composed from, each a step of the SDK
// with its inputs, outputs and failures declared. What a block's inputs and
// outputs are is typed by what they mean, so a document that wires a branch
// where a worktree goes doesn't compile. Its failure table must name exactly
// the errors its effect can raise: an SDK change that adds one fails to compile
// here, not in a run.
//
// A value proves what happened to the world where a value alone can't show it:
// a pull request opens only from a push's `pushed`, and a push only from the
// agent's `committed`. These prove what must be true for a step to work, never
// what a team chooses: nothing here demands the local gate or CI.

import {
  activity,
  Claims,
  defineFlow,
  describeError,
  type DoctorCheck,
  type FlowError,
  type FlowLabel,
  GitHub,
  NeedsHuman,
  NothingCommitted,
  Repo,
  reportAs,
  Skip,
  StepFailed,
  type TriggeredFlow,
  type WorkflowServices,
  type WorkItem,
} from "@chernabog/core";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import * as Implement from "./implement.ts";
import * as PullRequest from "./pull-request.ts";
import * as Review from "./review.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";

export type IssueNumber = number & Brand.Brand<"IssueNumber">;

const IssueNumber = Brand.nominal<IssueNumber>();

export type PullRequestNumber = number & Brand.Brand<"PullRequestNumber">;

const PullRequestNumber = Brand.nominal<PullRequestNumber>();

export type BranchName = string & Brand.Brand<"BranchName">;

const BranchName = Brand.nominal<BranchName>();

export type BaseBranch = string & Brand.Brand<"BaseBranch">;

const BaseBranch = Brand.nominal<BaseBranch>();

export type WorktreePath = string & Brand.Brand<"WorktreePath">;

const WorktreePath = Brand.nominal<WorktreePath>();

// That the agent committed its work, that a branch was pushed, and that a
// review approved.
export class Committed extends Schema.TaggedClass<Committed, { readonly brand: "Committed" }>()(
  "Committed",
  {},
) {}

export class Pushed extends Schema.TaggedClass<Pushed, { readonly brand: "Pushed" }>()(
  "Pushed",
  {},
) {}

export class Approved extends Schema.TaggedClass<Approved, { readonly brand: "Approved" }>()(
  "Approved",
  {},
) {}

// A pull request a step can name, by the number it can only be.
const pullRequestRef = <A extends Implement.PullRequestRef>(ref: A) => ({
  ...ref,
  number: PullRequestNumber(ref.number),
});

// Claim always settles a base; only a run claimed before bases resumes with none.
const onBase = (base: Option.Option<BaseBranch>) =>
  Option.match(base, { onNone: () => ({}), onSome: (branch) => ({ base: branch }) });

// Any number of days, as a block's wait is written.
type Days = `${number} days`;

// What a block's failure comes to:
// - person: a person is told why, and the enclosing scope ends needing them;
// - told: a person already knows, and the enclosing scope ends needing them;
// - skip: nothing is left to do, and the enclosing scope ends skipped;
// - fail: the enclosing scope ends failed.
export type Disposition = "person" | "told" | "skip" | "fail";

type Tagged = { readonly _tag: string };

type Tags<E> = E extends Tagged ? E["_tag"] : never;

export type Failures<E> = { readonly [Tag in Tags<E>]: Disposition };

// A block's failure on its way to a person. The scope around the blocks tells
// them, since what it can tell them depends on what the run got to.
export class ToPerson extends Schema.TaggedError<ToPerson, { readonly brand: "ToPerson" }>()(
  "ToPerson",
  { reason: Schema.String },
) {}

const reasonOf = (error: Tagged) => {
  // Each says why in its reason; its message, as an Error's, is empty.
  if (error instanceof NeedsHuman || error instanceof Skip) {
    return error.reason;
  }

  if (error instanceof NothingCommitted) {
    return `the agent finished without committing anything on ${error.branch}`;
  }

  return describeError(error);
};

const told = (error: Tagged) => {
  if (error instanceof NeedsHuman) {
    return error;
  }

  return new NeedsHuman({ reason: reasonOf(error) });
};

const skipped = (error: Tagged) => {
  if (error instanceof Skip) {
    return error;
  }

  return new Skip({ reason: reasonOf(error) });
};

const failed = (block: string, error: Tagged) => {
  if (error instanceof StepFailed) {
    return error;
  }

  return new StepFailed({ step: block, message: reasonOf(error) });
};

const settled = (block: string, error: Tagged, disposition: Disposition): FlowError | ToPerson => {
  switch (disposition) {
    case "person":
      return new ToPerson({ reason: reasonOf(error) });
    case "told":
      return told(error);
    case "skip":
      return skipped(error);
    case "fail":
      return failed(block, error);
  }
};

// The fields of a flow's settings a block reads, none of which needs a service.
type SettingsFields = {
  readonly [key: string]: Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  };
};

// What using a block adds to its flow, unasked.
export type Contribution = {
  readonly settings?: SettingsFields;
  readonly labels?: ReadonlyArray<FlowLabel>;
  readonly doctor?: ReadonlyArray<DoctorCheck>;
  // Finds runs of this flow parked in the block, to wake them.
  readonly wakes?: TriggeredFlow["trigger"];
  readonly ownWork?: boolean;
};

const DispositionTable = Schema.Record(
  Schema.String,
  Schema.Literals(["person", "told", "skip", "fail"]),
);

const InputNeeds = Schema.Record(Schema.String, Schema.Literals(["required", "optional"]));

const dispositionsOf = Schema.decodeUnknownSync(DispositionTable);

const inputNeedsOf = Schema.decodeUnknownSync(InputNeeds);

type BlockSpec<Input, Output, E, R, Outcomes> = {
  readonly name: string;
  // Each input and whether a document must wire it. An input it needn't wire
  // has a default.
  readonly inputs: { readonly [Name in keyof Input]-?: "required" | "optional" };
  readonly run: (input: Input) => Effect.Effect<Output, E, R>;
  readonly failures: Failures<NoInfer<E>>;
  // The branches a document can take on the block's output, each the value it
  // binds there, or none when the output didn't take it.
  readonly outcomes: Outcomes;
  // The outcomes a document must say what to do about.
  readonly mustRoute: ReadonlyArray<keyof Outcomes & string>;
  // Whether every run comes to one of the outcomes, so a document whose
  // branches all end has nothing after the block.
  readonly exhaustive?: boolean;
  readonly contributes: Contribution;
};

export const defineBlock = <
  Input,
  Output,
  E extends Tagged,
  R,
  const Outcomes extends {
    readonly [Name in string]: (output: Output) => Option.Option<unknown>;
  },
>(
  spec: BlockSpec<Input, Output, E, R, Outcomes>,
) => {
  const table = dispositionsOf(spec.failures);

  return {
    name: spec.name,
    inputs: inputNeedsOf(spec.inputs),
    outcomes: spec.outcomes,
    mustRoute: spec.mustRoute,
    exhaustive: spec.exhaustive === true,
    contributes: spec.contributes,
    run: (input: Input, overrides: Partial<Failures<NoInfer<E>>> = {}) => {
      const own = dispositionsOf(overrides);

      return spec.run(input).pipe(
        Effect.mapError((error) =>
          settled(
            spec.name,
            error,
            Option.getOrElse(
              Option.orElse(Record.get(own, error._tag), () => Record.get(table, error._tag)),
              (): Disposition => "fail",
            ),
          ),
        ),
      );
    },
  };
};

const summaryOf = (pullRequest: PullRequestNumber, round: number) =>
  `#${pullRequest}: review ${round} requested changes`;

const MergeState = Schema.Struct({ mergeable_state: Schema.String });

// Whether GitHub says the pull request conflicts with its base. Recorded, so
// a run that resumes takes the same path.
const conflicts = (pullRequest: number) =>
  activity(
    `conflicts-pr-${pullRequest}`,
    Effect.gen(function* () {
      const repo = yield* Repo;

      const pull = yield* (yield* GitHub).request(
        "GET",
        `/repos/${repo.slug}/pulls/${pullRequest}`,
        Option.none(),
      );

      return Schema.decodeUnknownOption(MergeState)(pull).pipe(
        Option.exists((state) => state.mergeable_state === "dirty"),
      );
    }),
    Schema.Boolean,
  );

// Everything a document can use, by the name it uses it by.
export const catalogue = {
  "issue.claim": defineBlock({
    name: "issue.claim",
    inputs: { issue: "required", queued: "required", adopt: "optional" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly queued: Implement.QueueOptions;
      readonly adopt?: boolean;
    }) =>
      Implement.claim(input.issue, { ...input.queued, adopt: input.adopt === true }).pipe(
        Effect.map((claim) => ({
          branch: BranchName(claim.branch),
          base: Option.map(Option.fromUndefinedOr(claim.base), BaseBranch),
          adopted: claim.adopted,
        })),
      ),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "person" },
    outcomes: {
      adopted: (claim: { readonly adopted?: Implement.Adopted }) =>
        Option.map(Option.fromUndefinedOr(claim.adopted), pullRequestRef),
    },
    contributes: { settings: Settings.Base.fields },
    mustRoute: [],
  }),

  "pr.awaitReady": defineBlock({
    name: "pr.awaitReady",
    inputs: { issue: "required", adopted: "required", within: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly adopted: Implement.Adopted;
      readonly within: Days;
    }) =>
      Effect.gen(function* () {
        // A draft is its author's until they mark it ready.
        if (
          input.adopted.draft &&
          (yield* Implement.awaitReady(input.issue, input.adopted.number, input.within)) ===
            "timeout"
        ) {
          return yield* new NeedsHuman({
            reason: `#${input.adopted.number} is still a draft after ${input.within}`,
          });
        }
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    contributes: {
      labels: Implement.adoptionLabels,
      wakes: Implement.readied.pipe(reportAs("trigger")),
    },
    outcomes: {},
    mustRoute: [],
  }),

  "ci.waitPreparing": defineBlock({
    name: "ci.waitPreparing",
    inputs: { pr: "required", branch: "required", base: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
    }) =>
      Implement.waitForCiMaking(
        input.pr,
        // The worktree is made only for a fix.
        Implement.prepareWorktree(input.branch, onBase(input.base)),
        { ...Implement.thisRunsSession, branch: input.branch, ...onBase(input.base) },
      ),
    failures: {
      CiTimedOut: "person",
      NeedsHuman: "person",
      NothingCommitted: "person",
      PushRejected: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    contributes: { settings: Settings.Ci.fields },
    outcomes: {},
    mustRoute: [],
  }),

  "issue.handOffAdopted": defineBlock({
    name: "issue.handOffAdopted",
    inputs: { issue: "required", adopted: "required", branch: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly adopted: Implement.Adopted;
      readonly branch: BranchName;
    }) =>
      Implement.handOff(input.issue, input.adopted, Implement.adoptedOutcome(input.adopted), {
        needsReview: true,
        adoptedBranch: input.branch,
      }),
    failures: {
      NeedsHuman: "person",
      NotFound: "skip",
      PullRequestClosed: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    contributes: { settings: Settings.Reviewers.fields, doctor: [Review.poolCheck] },
    outcomes: {},
    mustRoute: [],
  }),

  "worktree.prepare": defineBlock({
    name: "worktree.prepare",
    inputs: { branch: "required", base: "required" },
    run: (input: { readonly branch: BranchName; readonly base: Option.Option<BaseBranch> }) =>
      Implement.prepareWorktree(input.branch, onBase(input.base)).pipe(Effect.map(WorktreePath)),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "agent.implement": defineBlock({
    name: "agent.implement",
    inputs: { issue: "required", worktree: "required", base: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly worktree: WorktreePath;
      readonly base: Option.Option<BaseBranch>;
    }) =>
      Implement.implementWithAgent(input.issue, input.worktree, onBase(input.base)).pipe(
        Effect.map((outcome) => ({ outcome, committed: new Committed({}) })),
      ),
    failures: { NeedsHuman: "told", NotFound: "skip", Skip: "skip", StepFailed: "person" },
    outcomes: {
      "needs-clarification": (done: { readonly outcome: Implement.ImplementOutcome }) =>
        Option.liftPredicate(done.outcome, (outcome) => outcome.status === "needs-clarification"),
    },
    mustRoute: ["needs-clarification"],
    contributes: { settings: Settings.Rules.fields },
  }),

  "issue.askClarification": defineBlock({
    name: "issue.askClarification",
    inputs: { issue: "required", outcome: "required", queued: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly outcome: Implement.ImplementOutcome;
      readonly queued: Implement.QueueOptions;
    }) => Implement.askForClarification(input.issue, input.outcome, input.queued),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "gate.local": defineBlock({
    name: "gate.local",
    inputs: { worktree: "required" },
    run: (input: { readonly worktree: WorktreePath }) => Implement.localGate(input.worktree),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    contributes: { settings: Settings.LocalGate.fields },
    outcomes: {},
    mustRoute: [],
  }),

  "branch.push": defineBlock({
    name: "branch.push",
    inputs: { worktree: "required", branch: "required", base: "required", committed: "required" },
    run: (input: {
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly committed: Committed;
    }) =>
      Implement.push("push", input.worktree, input.branch, onBase(input.base)).pipe(
        Effect.as({ pushed: new Pushed({}) }),
      ),
    failures: {
      NeedsHuman: "person",
      NothingCommitted: "person",
      PushRejected: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "pr.open": defineBlock({
    name: "pr.open",
    inputs: {
      issue: "required",
      outcome: "required",
      queued: "required",
      base: "required",
      pushed: "required",
    },
    run: (input: {
      readonly issue: IssueNumber;
      readonly outcome: Implement.ImplementOutcome;
      readonly queued: Implement.QueueOptions;
      readonly base: Option.Option<BaseBranch>;
      readonly pushed: Pushed;
    }) =>
      Implement.openPullRequest(input.issue, input.outcome, {
        ...input.queued,
        ...onBase(input.base),
      }).pipe(Effect.map(pullRequestRef)),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "ci.waitAndFix": defineBlock({
    name: "ci.waitAndFix",
    inputs: { pr: "required", worktree: "required", branch: "required", base: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
    }) =>
      Implement.waitForCi(input.pr, input.worktree, {
        ...Implement.thisRunsSession,
        branch: input.branch,
        ...onBase(input.base),
      }),
    failures: {
      CiTimedOut: "person",
      NeedsHuman: "person",
      NothingCommitted: "person",
      PushRejected: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    contributes: { settings: Settings.Ci.fields },
    outcomes: {},
    mustRoute: [],
  }),

  "issue.handOff": defineBlock({
    name: "issue.handOff",
    inputs: { issue: "required", pr: "required", outcome: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly pr: { readonly number: PullRequestNumber; readonly url: string };
      readonly outcome: Implement.ImplementOutcome;
    }) => Implement.handOff(input.issue, input.pr, input.outcome),
    failures: {
      NeedsHuman: "person",
      NotFound: "skip",
      PullRequestClosed: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    contributes: { settings: Settings.Reviewers.fields, doctor: [Review.poolCheck] },
    outcomes: {},
    mustRoute: [],
  }),

  "review.round": defineBlock({
    name: "review.round",
    inputs: { pr: "required", round: "required", role: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly round: number;
      readonly role: string;
    }) =>
      Effect.gen(function* () {
        const review = yield* Review.round(input.pr, input.round, { role: input.role });
        yield* Review.doneReviewing(input.pr);

        return {
          verdict: review.verdict,
          changesAsked: summaryOf(input.pr, input.round),
        };
      }),
    failures: {
      NeedsHuman: "told",
      NotFound: "skip",
      PullRequestClosed: "skip",
      Skip: "skip",
      StepFailed: "fail",
    },
    outcomes: {
      approve: (review: { readonly verdict: string }) =>
        Option.liftPredicate({ approved: new Approved({}) }, () => review.verdict === "approve"),
      changes: (review: { readonly verdict: string }) =>
        Option.liftPredicate({}, () => review.verdict !== "approve"),
    },
    mustRoute: ["approve", "changes"],
    exhaustive: true,
    contributes: { settings: { ...Settings.Reviewers.fields, ...Settings.Rules.fields } },
  }),

  // Chernabog merges only pull requests on the automated path (auto:ship), and
  // only when that's safe; a person merges any other. A layer of a stack waits,
  // approved, for the layer below. One refused because it conflicts with its
  // base is left to resolve-conflicts.
  "pr.land": defineBlock({
    name: "pr.land",
    inputs: { pr: "required", approved: "required", method: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly approved: Approved;
      readonly method: "squash" | "merge" | "rebase";
    }) =>
      Effect.gen(function* () {
        if (!(yield* PullRequest.shipping(input.pr))) {
          return `#${input.pr} approved; a person merges`;
        }

        const waiting = yield* PullRequest.waitingOnLayer(input.pr);

        if (Option.isSome(waiting)) {
          return `#${input.pr} approved; ${waiting.value}`;
        }

        // While CI on the base branch is red, the merge holds rather than going to a person.
        return yield* PullRequest.mergeHolding(input.pr, { method: input.method }).pipe(
          Effect.catchTag("MergeRefused", (refused) =>
            Effect.gen(function* () {
              if (yield* conflicts(input.pr)) {
                return `#${input.pr} approved, but it conflicts with its base; resolve-conflicts takes it`;
              }

              return yield* PullRequest.handToPerson(input.pr, refused.message);
            }),
          ),
        );
      }),
    failures: {
      NeedsHuman: "told",
      NotFound: "skip",
      PullRequestClosed: "skip",
      Skip: "skip",
      StepFailed: "fail",
    },
    contributes: {
      settings: { ...Settings.Base.fields, ...Settings.MergeHold.fields },
      wakes: PullRequest.baseTurnedGreen.pipe(reportAs("trigger")),
    },
    outcomes: {},
    mustRoute: [],
  }),
};

export type BlockName = keyof typeof catalogue;

type Source = {
  readonly trigger: TriggeredFlow["trigger"];
  readonly contributes: Contribution;
};

// Where a flow's work comes from, by the name a document uses it by.
export const sources = {
  // Issues carrying each of `labels` of the repo's labels, oldest first but a
  // post-merge follow-up before the rest, the first label's before the next's.
  // One carrying several comes under the first. Any label but eligible queues
  // its issue by that label, which its pull request carries too.
  "issues.queued": (input: { readonly labels: ReadonlyArray<"eligible" | "ship"> }): Source => ({
    trigger: Effect.gen(function* () {
      const github = yield* GitHub;
      const names = yield* Settings.labels;
      const found = new Set<number>();
      const items: Array<WorkItem> = [];

      for (const key of input.labels) {
        const issues = (yield* github.queuedIssuesLabelled(names[key])).filter(
          (issue) => !found.has(issue.number),
        );

        for (const issue of issues) {
          found.add(issue.number);
        }

        const queuedAs = Option.liftPredicate(names[key], () => key !== "eligible");

        for (const item of yield* Implement.queued(Implement.followUpsFirst(issues), queuedAs)) {
          items.push(item);
        }
      }

      return items;
    }).pipe(reportAs("trigger")),
    contributes: {
      settings: { ...Routing.Settings.fields, ...Settings.Board.fields },
    },
  }),

  // Pull requests that ask this persona for a review it hasn't given yet,
  // routed by their assignees and reviewers.
  "review.requested": (): Source => ({
    trigger: Effect.gen(function* () {
      const found = yield* Review.reviewRequests;

      return yield* Effect.forEach(
        found.filter(({ reviewed }) => reviewed === 0),
        ({ pull }) => Review.routed(pull, Review.reviewItem(pull, `pr-${pull.number}`)),
      );
    }).pipe(reportAs("trigger")),
    contributes: {
      settings: Routing.Settings.fields,
      doctor: [Review.reviewerCheck],
      ownWork: true,
    },
  }),

  // Those waiting on a reviewer no persona on this machine acts as, which
  // status lists.
  "review.waitingElsewhere": (): Source => ({
    trigger: Review.waitingElsewhere.pipe(reportAs("trigger")),
    contributes: {},
  }),
};

export type SourceName = keyof typeof sources;

// What a scope's failures can tell a person beyond why: what the run got to.
type FailureContext = { pr: Option.Option<PullRequestNumber> };

type Scoped<A, E, R> = (context: FailureContext) => Effect.Effect<A, E, R>;

// What a flow works on: what a work item says of it, what a failure going to
// a person does with it, and how the engine tells whether it is still there.
export const subjects = {
  issue: {
    fields: ["issue", "queued"],
    failureContext: ["pr"],
    read: (item: WorkItem) =>
      Effect.gen(function* () {
        return {
          issue: IssueNumber(yield* Implement.issueOf(item)),
          queued: yield* Implement.queuedBy(item),
        };
      }),
    // However the run ends, a claim on the issue goes; the branch and any pull
    // request stay.
    scope: <A, E, R>(
      trigger: { readonly issue: IssueNumber },
      options: { readonly claims: boolean },
      body: Scoped<A, E | ToPerson, R>,
    ) => {
      const context: FailureContext = { pr: Option.none() };

      const handled = Effect.suspend(() => body(context)).pipe(
        Effect.catchIf(
          (failure): failure is ToPerson => failure instanceof ToPerson,
          (failure) =>
            Implement.handToHuman(trigger.issue, failure.reason, context.pr).pipe(
              Effect.flatMap(Implement.endForPerson),
            ),
        ),
      );

      if (options.claims) {
        return handled.pipe(Claims.releasing(Claims.issue(trigger.issue)));
      }

      return handled;
    },
    stillValid: Implement.stillValid,
  },

  "pull-request": {
    fields: ["pr"],
    failureContext: [],
    read: (item: WorkItem) =>
      Review.pullRequestOf(item).pipe(
        Effect.map(({ pullRequest }) => ({ pr: PullRequestNumber(pullRequest) })),
      ),
    scope: <A, E, R>(
      trigger: { readonly pr: PullRequestNumber },
      _options: { readonly claims: boolean },
      body: Scoped<A, E | ToPerson, R>,
    ) =>
      Effect.suspend(() => body({ pr: Option.some(trigger.pr) })).pipe(
        Effect.catchIf(
          (failure): failure is ToPerson => failure instanceof ToPerson,
          (failure) => PullRequest.handToPerson(trigger.pr, failure.reason),
        ),
      ),
    stillValid: Review.stillValid,
  },
};

export type SubjectName = keyof typeof subjects;

const unique = <A>(all: ReadonlyArray<A>) => [...new Set(all)];

// A flow from what a document says, with what its sources and blocks add:
// settings, labels, doctor checks, and the wake-ups of runs parked in them.
export const assemble = (flow: {
  readonly subject: SubjectName;
  readonly gate?: "usage";
  readonly concurrency?: number;
  readonly sources: ReadonlyArray<Source>;
  readonly blocks: ReadonlyArray<BlockName>;
  readonly workflow: (item: WorkItem) => Effect.Effect<string | void, FlowError, WorkflowServices>;
}) => {
  const contributions: ReadonlyArray<Contribution> = [
    ...flow.sources.map((source) => source.contributes),
    ...flow.blocks.map((block) => catalogue[block].contributes),
  ];

  const labels = unique(contributions.flatMap((each) => each.labels ?? []));

  const fields = {
    ...Settings.Labels.fields,
    ...Object.fromEntries(contributions.flatMap((each) => Object.entries(each.settings ?? {}))),
  };

  const triggers = [
    ...flow.sources.map((source) => source.trigger),
    ...unique(contributions.flatMap((each) => Option.toArray(Option.fromUndefinedOr(each.wakes)))),
  ];

  const common = {
    trigger: Effect.map(Effect.all(triggers), (found) => found.flat()),
    concurrency: flow.concurrency ?? 1,
    labels: Effect.map(Settings.declaredLabels, (set) => [...set, ...labels]),
    settings: Schema.Struct(fields),
    doctor: unique(contributions.flatMap((each) => each.doctor ?? [])),
    ownWork: contributions.some((each) => each.ownWork === true),
    stillValid: subjects[flow.subject].stillValid,
    workflow: flow.workflow,
  };

  if (flow.gate === "usage") {
    return defineFlow({ ...common, gate: Implement.gate });
  }

  return defineFlow(common);
};
