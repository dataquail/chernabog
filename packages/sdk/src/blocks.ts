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
  type FlowError,
  GitHub,
  type ItemLookup,
  NeedsHuman,
  Repo,
  reportAs,
  type StillValid,
  type WorkflowServices,
  type WorkItem,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  addressReviewBlocks,
  addressReviewSources,
  changesAskedSubject,
} from "./address-review-blocks.ts";
import {
  Approved,
  BaseBranch,
  BranchName,
  Committed,
  type Contribution,
  type Days,
  defineBlock,
  defineSource,
  type FailureContext,
  gather,
  inLane,
  IssueNumber,
  type LaneId,
  laneSession,
  onBase,
  PullRequestNumber,
  pullRequestRef,
  Pushed,
  runStage,
  type Source,
  ToPerson,
  WorktreePath,
} from "./block.ts";
import {
  epicBlocks,
  epicSources,
  epicSubject,
  laneScopes,
  loopStates as epicLoopStates,
} from "./epic-blocks.ts";
import { humanInitiatedBlocks } from "./human-initiated-blocks.ts";
import * as Hybrid from "./hybrid.ts";
import * as Implement from "./implement.ts";
import * as Phases from "./phases.ts";
import { NO_RECORD, PHASES } from "./phases.ts";
import { planBlocks, planLoopStates, planSources, specSubject } from "./plan-blocks.ts";
import { mergedSubject, postMergeBlocks, postMergeSources } from "./post-merge-blocks.ts";
import * as PullRequest from "./pull-request.ts";
import { reReviewBlocks, reReviewSources } from "./re-review-blocks.ts";
import {
  conflictSubject,
  resolveConflictsBlocks,
  resolveConflictsSources,
} from "./resolve-conflicts-blocks.ts";
import * as Review from "./review.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";
import { suited } from "./suits.ts";

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

// Step names more than one block uses.
const CI_STEPS = "ci";
const CLAIM_STEPS = "claim";
const HAND_OFF_STEPS = "hand-off";
const LOCAL_GATE_STEPS = "local-gate";
const OPEN_STEPS = "open-pull-request";
const PUSH_STEPS = "push";
const WORKTREE_STEPS = "prepare-worktree";

// The blocks of the files beside this one.
const elsewhere = gather("block", "epic-blocks.ts", epicBlocks)
  .and("re-review-blocks.ts", reReviewBlocks)
  .and("address-review-blocks.ts", addressReviewBlocks)
  .and("resolve-conflicts-blocks.ts", resolveConflictsBlocks)
  .and("post-merge-blocks.ts", postMergeBlocks)
  .and("human-initiated-blocks.ts", humanInitiatedBlocks)
  .and("plan-blocks.ts", planBlocks);

// Everything a document can use, by the name it uses it by.
export const catalogue = elsewhere.and("blocks.ts", {
  "issue.claim": defineBlock({
    name: "issue.claim",
    // Only these let its claim go: an issue's and a spec's scopes, and the
    // engine for an epic's tasks.
    suits: ["epic", "issue", "spec"],
    fixed: ["adopt"],
    about:
      "Claims the issue, so only this run works on it, and settles its branch and base. With adopt, takes on an open pull request that already closes the issue instead.",
    inputKinds: {
      issue: "IssueNumber",
      queued: "how the issue was queued, from the trigger",
      adopt: "boolean: adopt a pull request that closes the issue",
      base: "Option<BaseBranch>: the base to build on",
      lane: "LaneId",
    },
    outputKinds: {
      branch: "BranchName",
      base: "Option<BaseBranch>",
      adopted: "the adopted pull request, if any",
    },
    outcomeKinds: {
      adopted:
        "an object: with as: adopted, adopted.number (PullRequestNumber), adopted.url, adopted.draft",
    },
    opensOn: { adopted: ["hand-off"] },
    stepNames: [CLAIM_STEPS],
    inputs: {
      issue: "required",
      queued: "optional",
      adopt: "optional",
      base: "optional",
      lane: "optional",
    },
    run: (input: {
      readonly issue: IssueNumber;
      readonly queued?: Implement.QueueOptions;
      readonly adopt?: boolean;
      readonly base?: Option.Option<BaseBranch>;
      readonly lane?: LaneId;
    }) =>
      Implement.claim(input.issue, {
        ...input.queued,
        ...onBase(input.base ?? Option.none()),
        ...inLane(input.lane),
        adopt: input.adopt === true,
      }).pipe(
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
    fixed: ["within"],
    about:
      "Waits, parked, for the author of an adopted draft to mark it ready, up to `within`; goes to a person if they don't. Doesn't wait for one that isn't a draft.",
    inputKinds: {
      issue: "IssueNumber",
      adopted: "the adopted pull request, from issue.claim's adopted",
      within: 'how long, as "14 days"',
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["ci.waitPreparing", "issue.handOffAdopted"],
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
    records: [{ item: "issue", phase: PHASES.issue.awaitingReady }],
    contributes: {
      labels: Implement.adoptionLabels,
      wakes: Implement.readied.pipe(reportAs("trigger")),
      wakeReads: [{ item: "issue", phases: [PHASES.issue.awaitingReady] }],
    },
    outcomes: {},
    mustRoute: [],
  }),

  "ci.waitPreparing": defineBlock({
    name: "ci.waitPreparing",
    about:
      "Waits for CI on a pull request with no worktree yet, making one only if CI needs a fix.",
    inputKinds: { pr: "PullRequestNumber", branch: "BranchName", base: "Option<BaseBranch>" },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["issue.handOffAdopted"],
    stepNames: [CI_STEPS, WORKTREE_STEPS],
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
    about:
      "Hands an adopted pull request to review, marks it the persona's to answer reviews on, and tells the issue.",
    inputKinds: { issue: "IssueNumber", adopted: "the adopted pull request", branch: "BranchName" },
    outputKinds: "a summary of the hand-off, for `end`'s summary",
    outcomeKinds: {},
    closes: ["hand-off"],
    stepNames: [HAND_OFF_STEPS],
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
    records: [
      { item: "pull-request", phase: PHASES.pullRequest.reviewAsked },
      { item: "issue", phase: PHASES.issue.handedOff },
    ],
    contributes: { settings: Settings.Reviewers.fields, doctor: [Review.poolCheck] },
    outcomes: {},
    mustRoute: [],
  }),

  "worktree.prepare": defineBlock({
    name: "worktree.prepare",
    about: "Makes a worktree on the branch.",
    inputKinds: { branch: "BranchName", base: "Option<BaseBranch>", lane: "LaneId" },
    outputKinds: "WorktreePath",
    outcomeKinds: {},
    stepNames: [WORKTREE_STEPS],
    inputs: { branch: "required", base: "required", lane: "optional" },
    run: (input: {
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly lane?: LaneId;
    }) =>
      Implement.prepareWorktree(input.branch, {
        ...onBase(input.base),
        ...inLane(input.lane),
      }).pipe(Effect.map(WorktreePath)),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "agent.implement": defineBlock({
    name: "agent.implement",
    about:
      "Has the agent implement the issue in the worktree and commit. It finishes done, or with questions for a person.",
    inputKinds: {
      issue: "IssueNumber",
      worktree: "WorktreePath",
      base: "Option<BaseBranch>",
      lane: "LaneId",
    },
    outputKinds: {
      outcome: "what the agent said: status, summary, title, body, questions",
      committed: "Committed: proof for a push",
    },
    outcomeKinds: { "needs-clarification": "what the agent said, with its questions" },
    before: ["gate.local"],
    opensOn: { "needs-clarification": ["ask-questions"] },
    inputs: { issue: "required", worktree: "required", base: "required", lane: "optional" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly worktree: WorktreePath;
      readonly base: Option.Option<BaseBranch>;
      readonly lane?: LaneId;
    }) =>
      Implement.implementWithAgent(input.issue, input.worktree, {
        ...onBase(input.base),
        ...inLane(input.lane),
      }).pipe(Effect.map((outcome) => ({ outcome, committed: new Committed({}) }))),
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
    about:
      "Posts the agent's questions as a comment on the issue, where its author sees them. Its output is the reason to end with. On a run's main path, end: needs-human and the run lets the claim go; in a lane, which goes on, follow it with issue.releaseClaim.",
    inputKinds: {
      issue: "IssueNumber",
      outcome: "what the agent said, from agent.implement's needs-clarification",
      queued: "how the issue was queued",
      lane: "LaneId",
    },
    outputKinds: "the reason, for `end: needs-human`",
    outcomeKinds: {},
    opens: ["release-claim"],
    closes: ["ask-questions"],
    inputs: { issue: "required", outcome: "required", queued: "optional", lane: "optional" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly outcome: Implement.ImplementOutcome;
      readonly queued?: Implement.QueueOptions;
      readonly lane?: LaneId;
    }) =>
      Implement.askForClarification(input.issue, input.outcome, {
        ...input.queued,
        ...inLane(input.lane),
      }),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    records: [{ item: "issue", phase: PHASES.issue.askedQuestions }],
    contributes: {},
  }),

  "gate.local": defineBlock({
    name: "gate.local",
    about: "Runs the repo's local gate in the worktree, resuming the agent to fix a failure.",
    inputKinds: { worktree: "WorktreePath", lane: "LaneId" },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["branch.push", "pr.open", "stack.publish"],
    stepNames: [LOCAL_GATE_STEPS],
    inputs: { worktree: "required", lane: "optional" },
    run: (input: { readonly worktree: WorktreePath; readonly lane?: LaneId }) =>
      Effect.gen(function* () {
        const session = yield* laneSession(input.lane);

        return yield* Implement.localGate(input.worktree, { ...session, ...inLane(input.lane) });
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    contributes: { settings: Settings.LocalGate.fields },
    outcomes: {},
    mustRoute: [],
  }),

  "branch.push": defineBlock({
    name: "branch.push",
    about: "Pushes the branch.",
    inputKinds: {
      worktree: "WorktreePath",
      branch: "BranchName",
      base: "Option<BaseBranch>",
      committed: "Committed: from agent.implement",
    },
    outputKinds: { pushed: "Pushed: proof for pr.open" },
    outcomeKinds: {},
    stepNames: [PUSH_STEPS],
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
    fixed: ["draft"],
    about:
      "Opens the pull request for the pushed branch, ready for review, or with draft: true as a draft. It leaves the hand-off to do: issue.handOff, which asks nobody to review a draft and tells the issue a person marks it ready; pr.readyForPerson, which gives it to a person as the run's success; or pr.handToPerson and end: needs-human.",
    inputKinds: {
      issue: "IssueNumber",
      outcome: "what the agent said",
      queued: "how the issue was queued",
      base: "Option<BaseBranch>",
      pushed: "Pushed: from branch.push",
      draft: "boolean: open it as a draft; false unless given",
    },
    outputKinds: {
      number: "PullRequestNumber",
      url: "its URL",
      draft: "boolean: whether it opened as a draft, for issue.handOff",
    },
    outcomeKinds: {},
    opens: ["hand-off"],
    stepNames: [OPEN_STEPS],
    inputs: {
      issue: "required",
      outcome: "required",
      queued: "required",
      base: "required",
      pushed: "required",
      draft: "optional",
    },
    run: (input: {
      readonly issue: IssueNumber;
      readonly outcome: Implement.ImplementOutcome;
      readonly queued: Implement.QueueOptions;
      readonly base: Option.Option<BaseBranch>;
      readonly pushed: Pushed;
      readonly draft?: boolean;
    }) =>
      Implement.openPullRequest(input.issue, input.outcome, {
        ...input.queued,
        ...onBase(input.base),
        draft: input.draft === true,
      }).pipe(Effect.map((opened) => ({ ...pullRequestRef(opened), draft: input.draft === true }))),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "ci.waitAndFix": defineBlock({
    name: "ci.waitAndFix",
    about:
      "Waits for CI, having the agent fix red in the worktree, up to the repo's limit of rounds.",
    inputKinds: {
      pr: "PullRequestNumber",
      worktree: "WorktreePath",
      branch: "BranchName",
      base: "Option<BaseBranch>",
      lane: "LaneId",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["issue.handOff"],
    stepNames: [CI_STEPS],
    inputs: {
      pr: "required",
      worktree: "required",
      branch: "required",
      base: "required",
      lane: "optional",
    },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly lane?: LaneId;
    }) =>
      Effect.gen(function* () {
        const session = yield* laneSession(input.lane);

        return yield* Implement.waitForCi(
          input.pr,
          input.worktree,
          { ...session, branch: input.branch, ...onBase(input.base) },
          inLane(input.lane),
        );
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
    about:
      "Asks a reviewer from the pool for a review, and tells the issue. A draft from pr.open asks nobody: the issue is told a person marks it ready for review.",
    inputKinds: {
      issue: "IssueNumber",
      pr: "a pull request, from pr.open or stack.publish",
      outcome: "what the agent said",
      lane: "LaneId",
    },
    outputKinds: "a summary of the hand-off, for `end`'s summary",
    outcomeKinds: {},
    closes: ["hand-off"],
    stepNames: [HAND_OFF_STEPS],
    inputs: { issue: "required", pr: "required", outcome: "required", lane: "optional" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly pr: {
        readonly number: PullRequestNumber;
        readonly url: string;
        readonly draft?: boolean;
      };
      readonly outcome: Implement.ImplementOutcome;
      readonly lane?: LaneId;
    }) =>
      Implement.handOff(
        input.issue,
        { number: input.pr.number, url: input.pr.url },
        input.outcome,
        {
          // A draft is a person's to mark ready, and to ask for its review.
          needsReview: input.pr.draft !== true,
          draft: input.pr.draft === true,
          ...inLane(input.lane),
        },
      ),
    failures: {
      NeedsHuman: "person",
      NotFound: "skip",
      PullRequestClosed: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    records: [
      { item: "pull-request", phase: PHASES.pullRequest.reviewAsked },
      { item: "pull-request", phase: PHASES.pullRequest.draft },
      { item: "issue", phase: PHASES.issue.handedOff },
    ],
    contributes: { settings: Settings.Reviewers.fields, doctor: [Review.poolCheck] },
    outcomes: {},
    mustRoute: [],
  }),

  "review.round": defineBlock({
    name: "review.round",
    fixed: ["role"],
    // A single review gives its round; a loop's rounds take theirs from the loop.
    either: ["round"],
    about: "Has a fresh agent session review the pull request and post a real GitHub review.",
    inputKinds: {
      pr: "PullRequestNumber",
      round:
        "it names the review's steps: 1 for a single review, and in a repeat, round from the loop, so each round's review is a new one",
      role: "any name, such as reviewer. Optional in config: flows.<flow>.agents.<role> picks the agent for it, and without that it's the flow's agent",
    },
    outputKinds: {
      verdict: "approve or request-changes",
      changesAsked: "a summary, for `end`'s summary",
    },
    outcomeKinds: {
      approve: "an object: with as: verdict, verdict.approved is the Approved proof for pr.land",
      changes: "nothing",
    },
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
    records: [
      { item: "pull-request", phase: PHASES.pullRequest.changesAsked, on: "changes" },
      { item: "pull-request", phase: PHASES.pullRequest.approved, on: "approve" },
    ],
    contributes: { settings: { ...Settings.Reviewers.fields, ...Settings.Rules.fields } },
  }),

  // Chernabog merges only pull requests on the automated path (auto:ship), and
  // only when that's safe; a person merges any other. A layer of a stack waits,
  // approved, for the layer below. One refused because it conflicts with its
  // base is left to resolve-conflicts.
  "pr.land": defineBlock({
    name: "pr.land",
    fixed: ["method"],
    about:
      "Merges an approved pull request only if it is labelled auto:ship (the repo's ship label), and when that's safe. Without the label it merges nothing: a person does. One that conflicts is left to resolve-conflicts.",
    inputKinds: {
      pr: "PullRequestNumber",
      approved: "Approved: from review.round",
      method: "squash, merge or rebase",
    },
    outputKinds: "a summary, for `end`'s summary",
    outcomeKinds: {},
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
    records: [{ item: "pull-request", phase: PHASES.pullRequest.mergeHeld }],
    contributes: {
      settings: { ...Settings.Base.fields, ...Settings.MergeHold.fields },
      wakes: PullRequest.baseTurnedGreen.pipe(reportAs("trigger")),
      wakeReads: [{ item: "pull-request", phases: [PHASES.pullRequest.mergeHeld] }],
    },
    outcomes: {},
    mustRoute: [],
  }),

  // A team's own phase, recorded on the run's item where a document's own
  // stage stands in for the block that would record one, or a phase no block
  // has. What it declares is what the check across the repo's flows reads.
  "progress.advance": defineBlock({
    name: "progress.advance",
    fixed: ["phase"],
    about:
      "Records that the run's item has reached phase: an issue's on an issue or spec, a pull request's on a flow about one, an epic's on an epic. Use it for a team's own phase, or where a stage of the repo's own does what a block that records a phase would, so the flow that reads that phase still finds the item. chernabog recipes compile warns when a phase is read that no flow records.",
    inputKinds: {
      phase:
        "a phase's name, lower-case words joined by hyphens: one of the SDK's, which the listing's records and reads name, or the team's own",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    inputs: { phase: "required" },
    run: (input: { readonly phase: string }) => Phases.advanceRun(input.phase),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    stepNames: [],
    recordsInput: "phase",
    contributes: {},
  }),
}).entries;

export type BlockName = keyof typeof catalogue;

// The sources of the files beside this one.
const sourcesElsewhere = gather("source", "epic-blocks.ts", epicSources)
  .and("re-review-blocks.ts", reReviewSources)
  .and("address-review-blocks.ts", addressReviewSources)
  .and("resolve-conflicts-blocks.ts", resolveConflictsSources)
  .and("post-merge-blocks.ts", postMergeSources)
  .and("plan-blocks.ts", planSources);

// The labels issues.queued queues by, by what each means.
const QUEUE_LABELS = ["eligible", "ship"] as const;

type QueueLabel = (typeof QUEUE_LABELS)[number];

// Where a flow's work comes from, by the name a document uses it by.
export const sources = sourcesElsewhere.and("blocks.ts", {
  // Issues carrying each of `labels` of the repo's labels, oldest first but a
  // post-merge follow-up before the rest, the first label's before the next's.
  // One carrying several comes under the first. Any label but eligible queues
  // its issue by that label, which its pull request carries too.
  "issues.queued": defineSource(
    "issues.queued",
    "issue",
    (input: { readonly labels: ReadonlyArray<QueueLabel> }) => ({
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
  ),

  // Pull requests that ask this persona for their first review, by their
  // record (Review.requestedFirst), routed by their assignees and reviewers.
  // One whose record GitHub disagrees with is held, for status to show why.
  "review.requested": defineSource(
    "review.requested",
    "pull-request",
    () => ({
      trigger: Review.requestedFirst.pipe(reportAs("trigger")),
      contributes: {
        settings: Routing.Settings.fields,
        doctor: [Review.reviewerCheck],
        ownWork: true,
      },
    }),
    {
      reads: [
        {
          item: "pull-request",
          phases: [
            PHASES.pullRequest.reviewAsked,
            PHASES.pullRequest.draft,
            PHASES.pullRequest.readyForPerson,
            NO_RECORD,
          ],
        },
      ],
    },
  ),

  // Those waiting on a reviewer no persona on this machine acts as, which
  // status lists.
  "review.waitingElsewhere": defineSource(
    "review.waitingElsewhere",
    "pull-request",
    () => ({
      trigger: Review.waitingElsewhere.pipe(reportAs("trigger")),
      contributes: {},
    }),
    { reads: [{ item: "pull-request", phases: [PHASES.pullRequest.reviewAsked, NO_RECORD] }] },
  ),
} satisfies { readonly [name: string]: { readonly subject: SubjectName } }).entries;

// What a loop's state can start from, by the name a document uses it by.
export const loopStates = { ...epicLoopStates, ...planLoopStates };

export { Approved, Committed, defineBlock, gather, laneScopes, Pushed, runStage, ToPerson };

export type { Disposition, Failures, StageFailures, StageKey } from "./block.ts";

// What each source does and takes, for someone choosing one.
export const sourceDescriptions = {
  "epic.queued": {
    about: "Open issues labelled auto:epic with an open task, and wakes a run parked on one.",
    with: {},
  },
  "issues.queued": {
    about:
      "Open issues carrying each of the labels, oldest first but a post-merge follow-up before the rest.",
    with: {
      labels:
        "a list of eligible and ship, which name the repo's labels (auto:eligible and auto:ship by default). The first is the normal queue; an issue queued by a later one carries that label to its pull request. To queue a flow's issues by a label of its own, such as docs, set flows.<flow>.settings.labels.eligible to it in .chernabog/config.yaml.",
    },
    choices: { labels: QUEUE_LABELS },
  },
  "pr.conflicting": {
    about:
      "Pull requests this persona wrote that GitHub says conflict with their base (mergeable_state dirty), except those labelled auto:needs-human or owned by another run. One GitHub hasn't checked yet is left for the next tick. Each run's key carries the head: pr-7-abc1234, so a conflict that comes back after a later push is new work.",
    with: {},
  },
  "plan.queued": {
    about:
      "Open issues labelled auto:plan, oldest first, each a spec to plan; with a board, only those whose Status is its readyStatus. Each is routed by its assignees, and its run's key is the issue's: issue-7.",
    with: {},
  },
  "pr.mergedRecently": {
    about:
      "Pull requests this persona wrote that merged into the flow's base branch (its base setting, or GitHub's default branch) in the last day, among the 30 closed most lately, and that no run has watched yet: merged.markWatched leaves a marker that this looks for. Each run's key is the pull request's: merged-7.",
    with: {},
  },
  "review.requested": {
    about: "Pull requests that ask this persona for a review it hasn't given yet.",
    with: {},
  },
  "review.changesRequested": {
    about:
      "Pull requests this persona wrote whose latest approval or request for changes asks for changes on the current head, so nothing was pushed since, except those labelled auto:needs-human or owned by another run. Each run's key carries the review: pr-7-changes-2.",
    with: {},
  },
  "review.requestedAgain": {
    about:
      "Pull requests that ask this persona to review again after it reviewed them, one run per request, except those labelled auto:needs-human. Each run's key carries the review it asks for: pr-7-review-2.",
    with: {},
  },
  "review.waitingElsewhere": {
    about: "Pull requests waiting on a reviewer no persona on this machine acts as, for status.",
    with: {},
  },
} satisfies {
  readonly [Name in SourceName]: {
    readonly about: string;
    readonly with: { readonly [input: string]: string };
    // The values a list under with may hold, where they are a closed set.
    readonly choices?: { readonly [input: string]: ReadonlyArray<string> };
  };
};

export type SourceName = keyof typeof sources;

type Scoped<A, E, R> = (context: FailureContext) => Effect.Effect<A, E, R>;

// What a flow works on: what a work item says of it, what a failure going to
// a person does with it, and how the engine tells whether it is still there.
export const subjects = {
  "changes-asked": changesAskedSubject,

  conflict: conflictSubject,

  epic: epicSubject,

  issue: {
    fields: ["issue", "queued"],
    kinds: { issue: "IssueNumber", queued: "how the issue was queued" },
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
    stillValid: Option.some(Implement.stillValid),
  },

  merged: mergedSubject,

  spec: specSubject,

  "pull-request": {
    fields: ["pr"],
    kinds: { pr: "PullRequestNumber" },
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
    stillValid: Option.some(Review.stillValid),
  },
};

export type SubjectName = keyof typeof subjects;

// The subjects each block suits, by what it needs: see suits.ts.
export const blockSubjects = suited(
  Object.values(catalogue),
  Object.fromEntries(Object.entries(subjects).map(([name, subject]) => [name, subject.kinds])),
);

// How a person names the work of a flow they start, rather than a trigger
// finding it, by the subject it's on: `chernabog start <issue>` names an issue,
// whatever its labels. A subject without one can't be started; so far only an
// issue can.
export const startOf = (subject: string): Option.Option<ItemLookup> =>
  Option.liftPredicate(Hybrid.itemFor, () => subject === "issue");

const unique = <A>(all: ReadonlyArray<A>) => [...new Set(all)];

// How the engine tells whether a subject's run is still wanted, when it can.
const stillValidOf = (subject: SubjectName): Option.Option<StillValid> =>
  subjects[subject].stillValid;

// A flow from what a document says, with what its sources and blocks add:
// settings, labels, doctor checks, and the wake-ups of runs parked in them. A
// flow a person starts has no sources and no trigger: it runs only when they
// name its work, which its subject's item lookup finds, and each run is
// theirs, so it finds only its own persona's work.
export const assemble = (flow: {
  readonly subject: SubjectName;
  readonly gate?: "usage";
  readonly concurrency?: number;
  readonly start?: boolean;
  readonly sources?: ReadonlyArray<Source>;
  readonly blocks: ReadonlyArray<BlockName>;
  // The document's tree as data (Compose.plan), which a run is drawn on. The
  // flow carries it, so the loader finds it on a flow compiled from a document.
  readonly plan?: Schema.Json;
  readonly workflow: (item: WorkItem) => Effect.Effect<string | void, FlowError, WorkflowServices>;
}) => {
  const flowSources = flow.sources ?? [];

  const contributions: ReadonlyArray<Contribution> = [
    ...flowSources.map((source) => source.contributes),
    ...flow.blocks.map((block) => catalogue[block].contributes),
  ];

  const labels = unique(contributions.flatMap((each) => each.labels ?? []));
  const namedLabels = unique(contributions.flatMap((each) => each.namedLabels ?? []));

  const fields = {
    ...Settings.Labels.fields,
    ...Object.fromEntries(contributions.flatMap((each) => Object.entries(each.settings ?? {}))),
  };

  const triggers = [
    ...flowSources.map((source) => source.trigger),
    ...unique(contributions.flatMap((each) => Option.toArray(Option.fromUndefinedOr(each.wakes)))),
  ];

  const doctor = unique(contributions.flatMap((each) => each.doctor ?? []));

  const common = {
    // None, as a recipe without one declares it, when the document gives none; the engine's default is 1.
    ...Option.match(Option.fromUndefinedOr(flow.concurrency), {
      onNone: () => ({}),
      onSome: (concurrency) => ({ concurrency }),
    }),
    labels: Effect.map(
      Effect.all([Settings.declaredLabels, Effect.all(namedLabels)]),
      ([set, named]) => [...set, ...labels, ...named],
    ),
    settings: Schema.Struct(fields),
    // None, as a recipe with no checks declares it, when nothing contributes one.
    ...Option.match(
      Option.liftPredicate(doctor, (checks) => checks.length > 0),
      {
        onNone: () => ({}),
        onSome: (checks) => ({ doctor: checks }),
      },
    ),
    // None, as a recipe that finds every persona's work declares it, when the flow does.
    ...Option.match(
      Option.liftPredicate(
        true,
        () => flow.start === true || contributions.some((each) => each.ownWork === true),
      ),
      {
        onNone: () => ({}),
        onSome: (ownWork) => ({ ownWork }),
      },
    ),
    // None, as a recipe without one declares it, when the subject has none.
    ...Option.match(stillValidOf(flow.subject), {
      onNone: () => ({}),
      onSome: (stillValid) => ({ stillValid }),
    }),
    // A team's own phase is recorded on the run's item, as the subject sees it.
    workflow: (item: WorkItem) =>
      flow
        .workflow(item)
        .pipe(Effect.provideService(Phases.RecordedOn, Phases.itemOfWork(flow.subject, item))),
    ...Option.match(
      Option.liftPredicate(Implement.gate, () => flow.gate === "usage"),
      {
        onNone: () => ({}),
        onSome: (gate) => ({ gate }),
      },
    ),
  };

  const started = Option.flatMap(
    Option.liftPredicate(flow.subject, () => flow.start === true),
    startOf,
  );

  const defined = Option.match(started, {
    onNone: () =>
      defineFlow({ ...common, trigger: Effect.map(Effect.all(triggers), (found) => found.flat()) }),
    onSome: (item) => defineFlow({ ...common, item, start: true }),
  });

  // Not enumerable, so the flow's keys stay those of a recipe written in
  // TypeScript, which declares none.
  return Option.match(Option.fromUndefinedOr(flow.plan), {
    onNone: () => defined,
    onSome: (plan) => Object.defineProperty({ ...defined }, "plan", { value: plan }),
  });
};
