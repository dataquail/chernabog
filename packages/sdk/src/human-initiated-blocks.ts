// The hybrid path's blocks, which the human-initiated recipe composes. A
// person starts the flow with `chernabog start <issue>`, rather than a trigger
// finding its work, and plans and implements the issue with the agent in a
// session in front of them. `chernabog open-pr`, from that session, ends it;
// then the change is checked, pushed and opened as a pull request labelled
// hybrid, CI is waited on, and a reviewer from the pool is asked. Fixes for
// the local gate and for red CI go back to the person's session, and a person
// merges.
//
// Until the session ends, a failure fails the run or stops it as it is, as the
// recipe's does: a session the person closes fails the run, which lets the
// claim go and keeps the issue in progress for their next start. After it, a
// failure goes to a person.

import { NeedsHuman, NothingCommitted } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BaseBranch,
  BranchName,
  Committed,
  defineBlock,
  type IssueNumber,
  onBase,
  type PullRequestNumber,
  pullRequestRef,
  Pushed,
  type WorktreePath,
} from "./block.ts";
import * as Hybrid from "./hybrid.ts";
import * as Implement from "./implement.ts";
import { PHASES } from "./phases.ts";
import * as Review from "./review.ts";
import * as Settings from "./settings.ts";

// The step names these share with the issue's blocks in blocks.ts, which a
// path can't take twice: claim, local-gate, push, open-pull-request, ci, hand-off.

// A branch with nothing on it past its base is told so in the words the recipe uses.
const committedNothing = <A, E, R>(effect: Effect.Effect<A, E | NothingCommitted, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is NothingCommitted => error instanceof NothingCommitted,
      (nothing) =>
        Effect.fail(
          new NeedsHuman({ reason: `nothing was committed on ${nothing.branch} before open-pr` }),
        ),
    ),
  );

export const humanInitiatedBlocks = {
  "hybrid.claim": defineBlock({
    name: "hybrid.claim",
    // Only these subjects' scopes let its claim go when the run ends.
    suits: ["issue", "spec"],
    about:
      "Claims the issue a person started with chernabog start, so only this run works on it, and makes its branch, auto/issue-<n>, or takes up the one an earlier start left. It labels the issue auto:in-progress, takes it out of the unattended queues (auto:eligible and auto:ship), and settles its base. An issue another run holds skips the run, naming how to let it go; one an unattended run left a branch for is left to it. The claim goes when the run ends, however it ends, and a session the person closes keeps the issue in progress for their next start.",
    inputKinds: { issue: "IssueNumber" },
    outputKinds: { branch: "BranchName", base: "Option<BaseBranch>" },
    outcomeKinds: {},
    stepNames: ["claim"],
    inputs: { issue: "required" },
    run: (input: { readonly issue: IssueNumber }) =>
      Hybrid.claim(input.issue).pipe(
        Effect.map((claim) => ({
          branch: BranchName(claim.branch),
          base: Option.map(Option.fromUndefinedOr(claim.base), BaseBranch),
        })),
      ),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: { ...Settings.Base.fields, ...Settings.Board.fields } },
  }),

  "hybrid.workWithPerson": defineBlock({
    name: "hybrid.workWithPerson",
    about:
      "Opens a session with the person and the agent on the issue, in the worktree, from the human-initiated prompt (.chernabog/prompts/human-initiated.md, or the SDK's own). It needs Claude under a launcher, since a person is in it. When they're done, the agent drafts the pull request with chernabog open-pr --draft and asks the person; their Yes, or their own chernabog open-pr, ends the session with its title, body and summary. A session the person closes first fails the run. There is one session per issue, so starting the issue again picks it back up.",
    inputKinds: {
      issue: "IssueNumber",
      worktree: "WorktreePath",
      base: "Option<BaseBranch>: the base to build on, from hybrid.claim",
    },
    outputKinds: {
      finished: "what open-pr recorded: the pull request's title and body, and a summary",
      committed: "Committed: proof for hybrid.push",
    },
    outcomeKinds: {},
    before: ["hybrid.localGate", "hybrid.push"],
    stepNames: ["work-with-person"],
    inputs: { issue: "required", worktree: "required", base: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly worktree: WorktreePath;
      readonly base: Option.Option<BaseBranch>;
    }) =>
      Hybrid.workWithPerson(input.issue, input.worktree, onBase(input.base)).pipe(
        Effect.map((finished) => ({ finished, committed: new Committed({}) })),
      ),
    failures: { NeedsHuman: "told", NotFound: "skip", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.Rules.fields },
  }),

  "hybrid.localGate": defineBlock({
    name: "hybrid.localGate",
    about:
      "Runs the repo's local gate in the worktree, sending a failure back to the person's session to fix, up to localGateRounds.",
    inputKinds: { issue: "IssueNumber", worktree: "WorktreePath" },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["hybrid.push", "hybrid.openPullRequest"],
    stepNames: ["local-gate"],
    inputs: { issue: "required", worktree: "required" },
    run: (input: { readonly issue: IssueNumber; readonly worktree: WorktreePath }) =>
      Effect.gen(function* () {
        const session = yield* Hybrid.personSession(input.issue);

        return yield* Implement.localGate(input.worktree, { session });
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.LocalGate.fields },
  }),

  "hybrid.push": defineBlock({
    name: "hybrid.push",
    about:
      "Pushes the branch the person worked on. The person watched the change written, so it pushes one that touches humanOnlyPaths too; a person still merges it. A branch with nothing committed past its base goes to a person, as does a push the remote rejects, such as a change to .github/workflows/ with a token that lacks the workflow scope.",
    inputKinds: {
      worktree: "WorktreePath",
      branch: "BranchName",
      base: "Option<BaseBranch>",
      committed: "Committed: from hybrid.workWithPerson",
    },
    outputKinds: { pushed: "Pushed: proof for hybrid.openPullRequest" },
    outcomeKinds: {},
    before: ["hybrid.openPullRequest"],
    stepNames: ["push"],
    inputs: { worktree: "required", branch: "required", base: "required", committed: "required" },
    run: (input: {
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly committed: Committed;
    }) =>
      committedNothing(
        Implement.push("push", input.worktree, input.branch, {
          ...onBase(input.base),
          withPerson: true,
        }),
      ).pipe(Effect.as({ pushed: new Pushed({}) })),
    failures: { NeedsHuman: "person", PushRejected: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "hybrid.openPullRequest": defineBlock({
    name: "hybrid.openPullRequest",
    about:
      "Opens the pull request for the pushed branch with the title and body open-pr recorded, or finds the one already open, and labels it hybrid, never auto:ship, so a person merges it.",
    inputKinds: {
      issue: "IssueNumber",
      finished: "what open-pr recorded, from hybrid.workWithPerson",
      base: "Option<BaseBranch>",
      pushed: "Pushed: from hybrid.push",
    },
    outputKinds: { number: "PullRequestNumber", url: "its URL" },
    outcomeKinds: {},
    opens: ["hand-off"],
    stepNames: ["open-pull-request"],
    inputs: { issue: "required", finished: "required", base: "required", pushed: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly finished: Hybrid.Finished;
      readonly base: Option.Option<BaseBranch>;
      readonly pushed: Pushed;
    }) =>
      Hybrid.openPullRequest(input.issue, input.finished, onBase(input.base)).pipe(
        Effect.map(pullRequestRef),
      ),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "hybrid.waitForCi": defineBlock({
    name: "hybrid.waitForCi",
    about:
      "Waits for CI on the pull request, sending red back to the person's session to fix and pushing the fix as hybrid.push does, up to ciRounds. CI still red after that, or still pending after ciTimeout, goes to a person.",
    inputKinds: {
      issue: "IssueNumber",
      pr: "PullRequestNumber",
      worktree: "WorktreePath",
      branch: "BranchName",
      base: "Option<BaseBranch>",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["hybrid.handOff"],
    stepNames: ["ci"],
    inputs: {
      issue: "required",
      pr: "required",
      worktree: "required",
      branch: "required",
      base: "required",
    },
    run: (input: {
      readonly issue: IssueNumber;
      readonly pr: PullRequestNumber;
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
    }) =>
      Effect.gen(function* () {
        const session = yield* Hybrid.personSession(input.issue);

        return yield* committedNothing(
          Implement.waitForCi(input.pr, input.worktree, {
            ...session,
            branch: input.branch,
            ...onBase(input.base),
          }),
        );
      }),
    failures: {
      CiTimedOut: "person",
      NeedsHuman: "person",
      PushRejected: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.Ci.fields },
  }),

  "hybrid.handOff": defineBlock({
    name: "hybrid.handOff",
    about:
      "Hands the pull request to review: leaves the session marker, so answering a review reopens the person's session, takes auto:in-progress off the issue and comments there with open-pr's summary, and asks one reviewer from the pool; a pull request closed meanwhile goes to a person. review, address-review and re-review take it from there, and a person merges.",
    inputKinds: {
      issue: "IssueNumber",
      pr: "the pull request, from hybrid.openPullRequest",
      finished: "what open-pr recorded, from hybrid.workWithPerson",
    },
    outputKinds: "a summary of the hand-off, for `end`'s summary",
    outcomeKinds: {},
    closes: ["hand-off"],
    stepNames: ["hand-off"],
    inputs: { issue: "required", pr: "required", finished: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly pr: { readonly number: PullRequestNumber; readonly url: string };
      readonly finished: Hybrid.Finished;
    }) => Hybrid.handOff(input.issue, input.pr, input.finished),
    failures: {
      NeedsHuman: "person",
      NotFound: "skip",
      PullRequestClosed: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    records: [
      { item: "pull-request", phase: PHASES.pullRequest.reviewAsked },
      { item: "issue", phase: PHASES.issue.handedOff },
    ],
    contributes: { settings: Settings.Reviewers.fields, doctor: [Review.poolCheck] },
  }),
};
