// The address-review's blocks: reading the review that asks for changes,
// finding the session that wrote the code, having that session weigh the
// review and make the changes, checking, pushing and waiting for CI on them,
// and asking the reviewer again. A run owns the pull request throughout, by
// its subject, so resolve-conflicts doesn't merge into the branch under it.

import { NeedsHuman, NothingCommitted, reportAs, type WorkItem } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BaseBranch,
  BranchName,
  Committed,
  defineBlock,
  defineSource,
  type FailureContext,
  onBase,
  PullRequestNumber,
  Pushed,
  ToPerson,
  WorktreePath,
} from "./block.ts";
import * as Implement from "./implement.ts";
import * as PullRequest from "./pull-request.ts";
import * as Review from "./review.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";

// The review that asks for changes, as the author weighs and answers it, and
// its round, which names the steps that answer it.
export type ChangesAsked = { readonly review: Review.ReviewResult; readonly round: number };

// The session that wrote the pull request's code, which answers its review.
export type AuthorSession = Implement.AuthorSession & { readonly withPerson: boolean };

// An author who committed nothing is told so in the words the recipe uses.
const committedNothing = <A, E, R>(effect: Effect.Effect<A, E | NothingCommitted, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is NothingCommitted => error instanceof NothingCommitted,
      (nothing) =>
        Effect.fail(
          new NeedsHuman({ reason: `the author agent committed nothing on ${nothing.branch}` }),
        ),
    ),
  );

// The author's reasons for not addressing a review, from author.consider's decline.
export type Dispute = { readonly reasons: string };

export const addressReviewBlocks = {
  "review.changesAsked": defineBlock({
    name: "review.changesAsked",
    about:
      "Reads the review that asks for changes on the pull request: its round, from the reviewer's marker, and what the reviewer said, for the author to weigh and answer.",
    inputKinds: {
      pr: "PullRequestNumber",
      reviewer: "the reviewer's login, trigger.reviewer",
      reviewedSha: "the commit the review is on, trigger.reviewedSha",
    },
    outputKinds: {
      review: "what the reviewer asked for, for the author's blocks",
      round: "the review's round, which names the steps that answer it",
    },
    outcomeKinds: {},
    stepNames: ["read-review"],
    inputs: { pr: "required", reviewer: "required", reviewedSha: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly reviewer: string;
      readonly reviewedSha: string;
    }) =>
      Review.changesAsked({
        pullRequest: input.pr,
        reviewer: input.reviewer,
        reviewedSha: input.reviewedSha,
      }).pipe(Effect.map((review): ChangesAsked => ({ review, round: review.round ?? 1 }))),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "author.session": defineBlock({
    name: "author.session",
    about:
      "Finds the agent session that wrote the pull request's code, from the session marker the run that opened it left on it, to answer the review in. On a layer of an epic's stack it is that task's own session, not the epic run's. A pull request a person worked on with the agent reopens their session in front of them. With no marker, it is a fresh session.",
    inputKinds: { pr: "PullRequestNumber" },
    outputKinds: {
      sessionId: "the session to resume",
      adapter: "the agent that ran it",
      withPerson: "whether a person worked in it",
    },
    outcomeKinds: {},
    stepNames: ["find-author"],
    inputs: { pr: "required" },
    run: (input: { readonly pr: PullRequestNumber }) =>
      Review.authorSession(input.pr).pipe(
        Effect.map((author): AuthorSession => ({
          sessionId: Option.some(author.sessionId),
          adapter: Option.some(author.adapter),
          withPerson: author.withPerson === true,
        })),
      ),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "author.worktree": defineBlock({
    name: "author.worktree",
    about: "Makes or reuses the worktree on the pull request's branch, and pulls it up to date.",
    inputKinds: { branch: "BranchName: the pull request's, trigger.branch" },
    outputKinds: "WorktreePath",
    outcomeKinds: {},
    // worktree.prepare's too.
    stepNames: ["prepare-worktree"],
    inputs: { branch: "required" },
    run: (input: { readonly branch: BranchName }) =>
      Review.prepareAuthorWorktree(input.branch).pipe(Effect.map(WorktreePath)),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "author.consider": defineBlock({
    name: "author.consider",
    about:
      "Resumes the author's session with the review and asks whether it will address the findings, or decline them with its reasons. It changes nothing. Its prompt is .chernabog/prompts/consider.md, or the SDK's own.",
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the review, from review.changesAsked",
      session: "the author's session, from author.session",
    },
    outputKinds: { status: "address or decline", reasons: "why, in Markdown" },
    outcomeKinds: {
      decline: "an object: reasons, the author's, for author.dispute",
    },
    before: ["author.address"],
    inputs: { pr: "required", review: "required", session: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly review: ChangesAsked;
      readonly session: AuthorSession;
    }) => Implement.considerFindings(input.pr, input.review.review, input.session),
    failures: { NeedsHuman: "person", NotFound: "skip", Skip: "skip", StepFailed: "person" },
    outcomes: {
      decline: (decision: Implement.Consideration): Option.Option<Dispute> =>
        Option.liftPredicate({ reasons: decision.reasons }, () => decision.status === "decline"),
    },
    mustRoute: ["decline"],
    contributes: { settings: Settings.Rules.fields },
  }),

  "author.dispute": defineBlock({
    name: "author.dispute",
    about:
      "Posts the author's reasons for not addressing the review, as \"Not addressing review N:\", and gives the reason to hand the pull request to a person by. A dispute is a person's to settle: follow it with pr.handToPerson, and push nothing.",
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the review, from review.changesAsked",
      dispute: "author.consider's decline",
    },
    outputKinds: "the reason, for pr.handToPerson",
    outcomeKinds: {},
    inputs: { pr: "required", review: "required", dispute: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly review: ChangesAsked;
      readonly dispute: Dispute;
    }) =>
      PullRequest.comment(
        input.pr,
        `Not addressing review ${input.review.round}:\n\n${input.dispute.reasons}`,
      ).pipe(Effect.as(`the author disputes review ${input.review.round}; see its reasons above`)),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "author.address": defineBlock({
    name: "author.address",
    about:
      "Resumes the author's session to make the changes the review asks for, and commit them. It finishes done, or with questions for a person. Its prompt is .chernabog/prompts/address.md, or the SDK's own.",
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the review, from review.changesAsked",
      session: "the author's session, from author.session",
    },
    outputKinds: {
      outcome: "what the agent said: status, summary, title, body, questions",
      summary: "what changed, for review.askAgain",
      round: "the review's round",
      committed: "Committed: proof for author.push",
    },
    outcomeKinds: {
      "needs-clarification":
        "an object: with as: questions, questions.reason is the agent's questions, for pr.handToPerson",
    },
    before: ["author.checkChanged", "author.localGate", "author.push"],
    inputs: { pr: "required", review: "required", session: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly review: ChangesAsked;
      readonly session: AuthorSession;
    }) =>
      Implement.addressFindings(input.pr, input.review.review, input.session).pipe(
        Effect.map((outcome) => ({
          outcome,
          summary: outcome.summary,
          round: input.review.round,
          committed: new Committed({}),
        })),
      ),
    failures: { NeedsHuman: "person", NotFound: "skip", Skip: "skip", StepFailed: "person" },
    outcomes: {
      "needs-clarification": (done: {
        readonly outcome: Implement.ImplementOutcome;
        readonly round: number;
      }) =>
        Option.liftPredicate(
          {
            reason: `the author agent needs a person to answer review ${done.round}:\n\n${done.outcome.questions ?? done.outcome.summary}`,
          },
          () => done.outcome.status === "needs-clarification",
        ),
    },
    mustRoute: ["needs-clarification"],
    contributes: { settings: Settings.Rules.fields },
  }),

  "author.checkChanged": defineBlock({
    name: "author.checkChanged",
    about:
      "Checks the author committed something since the review, and left nothing uncommitted, which a push would leave behind. Either goes to a person.",
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the review, from review.changesAsked",
      reviewedSha: "the commit the review is on, trigger.reviewedSha",
      worktree: "WorktreePath: from author.worktree",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    inputs: { pr: "required", review: "required", reviewedSha: "required", worktree: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly review: ChangesAsked;
      readonly reviewedSha: string;
      readonly worktree: WorktreePath;
    }) => Review.checkChanged(input.pr, input.review.round, input.reviewedSha, input.worktree),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "author.localGate": defineBlock({
    name: "author.localGate",
    about:
      "Runs the repo's local gate in the author's worktree, resuming the author's session to fix a failure, up to localGateRounds. Its steps carry the review's round: local-gate-1#review-2.",
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the review, from review.changesAsked",
      worktree: "WorktreePath: from author.worktree",
      session: "the author's session, from author.session",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["author.push"],
    inputs: { pr: "required", review: "required", worktree: "required", session: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly review: ChangesAsked;
      readonly worktree: WorktreePath;
      readonly session: AuthorSession;
    }) =>
      Implement.localGate(input.worktree, {
        id: `review-${input.review.round}`,
        session: input.session,
        pullRequest: input.pr,
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.LocalGate.fields },
  }),

  "author.push": defineBlock({
    name: "author.push",
    about:
      "Pushes the author's fix to the pull request's branch. A layer of a stack is checked against the layer below, so only its own commits count. Only a fix made in front of a person may touch humanOnlyPaths; on any other it goes to a person.",
    inputKinds: {
      worktree: "WorktreePath: from author.worktree",
      branch: "BranchName: the pull request's, trigger.branch",
      base: "Option<BaseBranch>: the pull request's, trigger.base",
      review: "the review, from review.changesAsked",
      session: "the author's session, from author.session",
      committed: "Committed: from author.address",
    },
    outputKinds: { pushed: "Pushed: proof for review.askAgain" },
    outcomeKinds: {},
    before: ["author.waitForCi", "review.askAgain"],
    inputs: {
      worktree: "required",
      branch: "required",
      base: "required",
      review: "required",
      session: "required",
      committed: "required",
    },
    run: (input: {
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly review: ChangesAsked;
      readonly session: AuthorSession;
      readonly committed: Committed;
    }) =>
      committedNothing(
        Implement.push(`push-review-${input.review.round}`, input.worktree, input.branch, {
          ...onBase(input.base),
          withPerson: input.session.withPerson,
        }),
      ).pipe(Effect.as({ pushed: new Pushed({}) })),
    failures: { NeedsHuman: "person", PushRejected: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: { ...Settings.Base.fields, ...Settings.Rules.fields } },
  }),

  "author.waitForCi": defineBlock({
    name: "author.waitForCi",
    about:
      "Waits for CI on the pushed fix, resuming the author's session to fix red, up to ciRounds. Its steps carry the review's round.",
    inputKinds: {
      pr: "PullRequestNumber",
      worktree: "WorktreePath: from author.worktree",
      branch: "BranchName: the pull request's, trigger.branch",
      base: "Option<BaseBranch>: the pull request's, trigger.base",
      review: "the review, from review.changesAsked",
      session: "the author's session, from author.session",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["review.askAgain"],
    inputs: {
      pr: "required",
      worktree: "required",
      branch: "required",
      base: "required",
      review: "required",
      session: "required",
    },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly review: ChangesAsked;
      readonly session: AuthorSession;
    }) =>
      committedNothing(
        Implement.waitForCi(
          input.pr,
          input.worktree,
          { ...input.session, branch: input.branch, ...onBase(input.base) },
          { id: `review-${input.review.round}` },
        ),
      ),
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

  "review.askAgain": defineBlock({
    name: "review.askAgain",
    about:
      'Comments "Addressed review N:" with what changed, and asks the reviewer who requested the changes, trigger.reviewer, to review again, which starts their re-review. Its output is a summary, for end\'s summary.',
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the review, from review.changesAsked",
      reviewer: "the login that requested the changes, trigger.reviewer",
      summary: "what changed, from author.address",
      pushed: "Pushed: from author.push",
    },
    outputKinds: "a summary, for `end`'s summary",
    outcomeKinds: {},
    inputs: {
      pr: "required",
      review: "required",
      reviewer: "required",
      summary: "required",
      pushed: "required",
    },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly review: ChangesAsked;
      readonly reviewer: string;
      readonly summary: string;
      readonly pushed: Pushed;
    }) =>
      Review.askAgain(input.pr, input.review.round, input.reviewer, input.summary).pipe(
        Effect.as(
          `#${input.pr}: addressed review ${input.review.round}; asked ${input.reviewer} to review again`,
        ),
      ),
    failures: {
      NeedsHuman: "person",
      PullRequestClosed: "skip",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.Reviewers.fields },
  }),
};

export const addressReviewSources = {
  // Pull requests this persona wrote whose latest approval or request for
  // changes asks for changes on the current head, so nothing was pushed since.
  // A person has one labelled auto:needs-human, and a run of another flow one
  // it owns; both are left alone. Each is routed by its assignees and reviewers.
  "review.changesRequested": defineSource("review.changesRequested", "changes-asked", () => ({
    trigger: Effect.gen(function* () {
      const labelNames = yield* Settings.labels;
      const items: Array<WorkItem> = [];

      for (const pull of yield* Review.authoredByMe) {
        if (pull.labels.includes(labelNames.needsHuman)) {
          continue;
        }

        const decisive = yield* Review.decisiveReviews(pull.number);
        const latest = Arr.last(decisive);

        if (
          !Option.exists(
            latest,
            (review) => review.state === "CHANGES_REQUESTED" && review.commitSha === pull.headSha,
          )
        ) {
          continue;
        }

        if (yield* Review.ownedByARun(pull)) {
          continue;
        }

        for (const review of Option.toArray(latest)) {
          items.push(yield* Review.routed(pull, Review.addressItem(pull, review, decisive.length)));
        }
      }

      return items;
    }).pipe(reportAs("trigger")),
    contributes: { settings: Routing.Settings.fields, ownWork: true },
  })),
};

// A review that asks for changes on a pull request this persona wrote. A run
// owns the pull request throughout, so no other run pushes to its branch, and
// lets it go however it ends; one another run owns is skipped. A failure going
// to a person labels the pull request auto:needs-human and comments why.
export const changesAskedSubject = {
  fields: ["pr", "branch", "base", "reviewer", "reviewedSha"],
  kinds: {
    pr: "PullRequestNumber",
    branch: "BranchName",
    base: "Option<BaseBranch>",
    reviewer: "the reviewer's login",
    reviewedSha: "the commit the review is on",
  },
  failureContext: [],
  read: (item: WorkItem) =>
    Review.addressItemOf(item).pipe(
      Effect.map((address) => ({
        pr: PullRequestNumber(address.pullRequest),
        branch: BranchName(address.headRef),
        base: Option.map(Option.fromUndefinedOr(address.baseRef), BaseBranch),
        reviewer: address.reviewer,
        reviewedSha: address.reviewedSha,
      })),
    ),
  scope: <A, E, R>(
    trigger: { readonly pr: PullRequestNumber },
    _options: { readonly claims: boolean },
    body: (context: FailureContext) => Effect.Effect<A, E | ToPerson, R>,
  ) =>
    Effect.suspend(() => body({ pr: Option.some(trigger.pr) })).pipe(
      Effect.catchIf(
        (failure): failure is ToPerson => failure instanceof ToPerson,
        (failure) => PullRequest.handToPerson(trigger.pr, failure.reason),
      ),
      PullRequest.owning(trigger.pr),
    ),
  stillValid: Option.some(Review.stillValid),
};
