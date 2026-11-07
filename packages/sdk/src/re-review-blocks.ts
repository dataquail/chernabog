// The re-review's blocks: finding this persona's own earlier review, capping
// the re-reviews, re-checking the earlier findings in the reviewer's own
// session, and handing the pull request to a person with a reason.

import { reportAs } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Approved, defineBlock, defineSource, type PullRequestNumber } from "./block.ts";
import * as PullRequest from "./pull-request.ts";
import * as Review from "./review.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";

// An earlier review this persona can resume: one with the session it ran in.
export type Resumable = Review.ReviewResult & { readonly sessionId: string };

const resumable = (review: Review.ReviewResult): Option.Option<Resumable> =>
  Option.map(Option.fromUndefinedOr(review.sessionId), (sessionId) => ({ ...review, sessionId }));

const reReviews = (count: number) => {
  if (count === 1) {
    return "1 re-review";
  }

  return `${count} re-reviews`;
};

const nonBlocking = (finding: Review.Finding) => {
  if (finding.blocking === false) {
    return " (doesn't block the merge)";
  }

  return "";
};

const listed = (findings: ReadonlyArray<Review.Finding>, remediated: boolean) =>
  findings.flatMap((finding) =>
    Option.toArray(
      Option.liftPredicate(
        `- ${finding.finding}${nonBlocking(finding)}`,
        () => finding.remediated === remediated,
      ),
    ),
  );

// The comment that says which of review `round`'s findings are remediated.
const reReviewed = (round: number, findings: ReadonlyArray<Review.Finding>) =>
  [
    `Review ${round}'s findings, re-reviewed.`,
    "",
    "Remediated:",
    ...listed(findings, true),
    "",
    "Still open:",
    ...listed(findings, false),
  ].join("\n");

export const reReviewBlocks = {
  "review.latestOwn": defineBlock({
    name: "review.latestOwn",
    about:
      "Finds this persona's latest review of the pull request, from the marker on it, to resume. It comes to none when there is no review of its own with a session to resume, such as one posted before markers named their reviewer: review afresh with review.round then.",
    inputKinds: { pr: "PullRequestNumber" },
    outputKinds: { review: "Option<the earlier review, with its session>" },
    outcomeKinds: {
      found:
        "the earlier review, with its round and the session to resume: for review.roundsLeft and review.recheck",
      none: "nothing",
    },
    inputs: { pr: "required" },
    run: (input: { readonly pr: PullRequestNumber }) =>
      Review.latestOwnReview(input.pr).pipe(
        Effect.map((earlier) => ({ review: Option.flatMap(earlier, resumable) })),
      ),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {
      found: (latest: { readonly review: Option.Option<Resumable> }) => latest.review,
      none: (latest: { readonly review: Option.Option<Resumable> }) =>
        Option.liftPredicate({}, () => Option.isNone(latest.review)),
    },
    mustRoute: ["found", "none"],
    exhaustive: true,
    contributes: {},
  }),

  "review.roundsLeft": defineBlock({
    name: "review.roundsLeft",
    about:
      "Counts the re-reviews the pull request has had against reviewRounds (1 by default, set in config.yaml). It comes to exhausted when none are left, with the reason to hand the pull request to a person by, without reviewing again.",
    inputKinds: { review: "the earlier review, from review.latestOwn's found" },
    outputKinds: { reReviews: "how many re-reviews it has had", limit: "reviewRounds" },
    outcomeKinds: {
      exhausted: "a reason, for pr.handToPerson: how many re-reviews it had, and the limit",
    },
    before: ["review.recheck"],
    inputs: { review: "required" },
    run: (input: { readonly review: Resumable }) =>
      Effect.gen(function* () {
        const { rounds } = yield* Settings.reviewers;

        return { reReviews: (input.review.round ?? 1) - 1, limit: rounds };
      }),
    failures: {},
    outcomes: {
      exhausted: (count: { readonly reReviews: number; readonly limit: number }) =>
        Option.liftPredicate(
          `asked to review again after ${reReviews(count.reReviews)}, and reviewRounds is ${count.limit}, so a person decides. Review ${count.reReviews + 1}'s findings are in its review above.`,
          () => count.reReviews >= count.limit,
        ),
    },
    mustRoute: ["exhausted"],
    stepNames: [],
    contributes: { settings: Settings.Reviewers.fields },
  }),

  "review.recheck": defineBlock({
    name: "review.recheck",
    about:
      "Resumes the reviewer's session of the earlier review with the change since, posts the next review, and comments which of the earlier review's findings are remediated and which are still open. A finding that doesn't block the merge never requests changes.",
    inputKinds: {
      pr: "PullRequestNumber",
      review: "the earlier review, from review.latestOwn's found",
    },
    outputKinds: {
      verdict: "approve or request-changes",
      round: "the new review's round",
    },
    outcomeKinds: {
      approve: "an object: with as: verdict, verdict.approved is the Approved proof for pr.land",
      changes:
        "an object: with as: open, open.reason says the review still requests changes, for pr.handToPerson",
    },
    inputs: { pr: "required", review: "required" },
    run: (input: { readonly pr: PullRequestNumber; readonly review: Resumable }) =>
      Effect.gen(function* () {
        const rechecked = yield* Review.recheck(input.pr, input.review);
        yield* Review.doneReviewing(input.pr);
        yield* PullRequest.comment(
          input.pr,
          reReviewed(input.review.round ?? 1, rechecked.findings),
        );

        return { verdict: rechecked.verdict, round: rechecked.round ?? 2 };
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
      changes: (review: { readonly verdict: string; readonly round: number }) =>
        Option.liftPredicate(
          { reason: `review ${review.round} still requests changes after a round of fixes` },
          () => review.verdict !== "approve",
        ),
    },
    mustRoute: ["approve", "changes"],
    exhaustive: true,
    contributes: { settings: { ...Settings.Reviewers.fields, ...Settings.Rules.fields } },
  }),

  "pr.handToPerson": defineBlock({
    name: "pr.handToPerson",
    either: ["reason"],
    about:
      "Labels the pull request auto:needs-human (the repo's needs-human label) and comments why a person must take it over. Its output is the reason to end with: follow it with end: needs-human.",
    inputKinds: {
      pr: "PullRequestNumber",
      reason: "why, as text a person reads on the pull request",
    },
    outputKinds: "the reason, for `end: needs-human`",
    outcomeKinds: {},
    inputs: { pr: "required", reason: "required" },
    run: (input: { readonly pr: PullRequestNumber; readonly reason: string }) =>
      PullRequest.handToPerson(input.pr, input.reason).pipe(
        Effect.catchTag("NeedsHuman", (told) => Effect.succeed(told.reason)),
      ),
    failures: { Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),
};

export const reReviewSources = {
  // Pull requests that ask this persona again after it reviewed them, one item
  // per request, unless a person has them (auto:needs-human): asking again
  // during a dispute doesn't restart the loop. Each item's key carries the
  // review it asks for, `pr-7-review-2`, so each request is a run of its own.
  "review.requestedAgain": defineSource("review.requestedAgain", "pull-request", () => ({
    trigger: Effect.gen(function* () {
      const labelNames = yield* Settings.labels;

      return yield* Effect.forEach(
        (yield* Review.reviewRequests).filter(
          ({ pull, reviewed }) => reviewed > 0 && !pull.labels.includes(labelNames.needsHuman),
        ),
        ({ pull, reviewed }) =>
          Review.routed(pull, Review.reviewItem(pull, `pr-${pull.number}-review-${reviewed + 1}`)),
      );
    }).pipe(reportAs("trigger")),
    contributes: {
      settings: Routing.Settings.fields,
      doctor: [Review.reviewerCheck],
      ownWork: true,
    },
  })),
};
