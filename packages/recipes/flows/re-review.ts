// Reviews again when the author asks: a pull request this persona reviewed
// requests its review once more. It resumes the session of its own review,
// says which findings are remediated, and approves, which merges an auto:ship
// pull request when that's safe, or requests changes again and hands the pull
// request to a person. limits.reviewRounds caps the re-reviews, and a pull
// request labelled auto:needs-human is left alone.
//
// This file is chernabog's re-review recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("find-review", "review-2") are the keys a
// run in flight resumes by, so renaming one restarts that step.

import {
  activity,
  defineFlow,
  GitHub,
  PullRequest,
  Repo,
  reportAs,
  Review,
  Routing,
  Settings,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Pull requests that ask this persona again after it reviewed them, one item
// per request, unless a person has them (auto:needs-human): asking again
// during a dispute doesn't restart the loop. Each is routed by its assignees and reviewers.
// And the runs holding a merge whose base branch is green again, to wake them.
const trigger = Effect.gen(function* () {
  const labelNames = yield* Settings.labels;

  const asked = yield* Effect.forEach(
    (yield* Review.reviewRequests).filter(
      ({ pull, reviewed }) => reviewed > 0 && !pull.labels.includes(labelNames.needsHuman),
    ),
    ({ pull, reviewed }) =>
      Review.routed(pull, Review.reviewItem(pull, `pr-${pull.number}-review-${reviewed + 1}`)),
  );

  return [...asked, ...(yield* PullRequest.baseTurnedGreen)];
}).pipe(reportAs("trigger"));

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

// Chernabog merges only pull requests on the automated path (auto:ship), and
// only when that's safe; a person merges any other. A layer of a stack waits,
// approved, for the layer below: the epic run merges it once it is on the
// base. One refused because it conflicts with its base is left to
// resolve-conflicts, which merges the base in and asks for this review again.
const mergeIfShipping = (pullRequest: number) =>
  Effect.gen(function* () {
    if (!(yield* PullRequest.shipping(pullRequest))) {
      return `#${pullRequest} approved; a person merges`;
    }

    const waiting = yield* PullRequest.waitingOnLayer(pullRequest);

    if (Option.isSome(waiting)) {
      return `#${pullRequest} approved; ${waiting.value}`;
    }

    // While CI on the base branch is red, the merge holds rather than going to a person.
    return yield* PullRequest.holdWhileBaseRed(pullRequest).pipe(
      Effect.andThen(PullRequest.merge(pullRequest, { method: "squash" })),
      Effect.catchTag("MergeRefused", (refused) =>
        Effect.gen(function* () {
          if (yield* conflicts(pullRequest)) {
            return `#${pullRequest} approved, but it conflicts with its base; resolve-conflicts takes it`;
          }

          return yield* PullRequest.handToPerson(pullRequest, refused.message);
        }),
      ),
    );
  });

// A first review, for a pull request with no review of this persona's to resume.
const reviewAfresh = (pullRequest: number) =>
  Effect.gen(function* () {
    const review = yield* Review.round(pullRequest, 1, { role: "reviewer" });
    yield* Review.doneReviewing(pullRequest);

    if (review.verdict === "approve") {
      return yield* mergeIfShipping(pullRequest);
    }

    return `#${pullRequest}: review 1 requested changes`;
  });

const listed = (findings: ReadonlyArray<Review.Finding>, remediated: boolean) =>
  findings.flatMap((finding) =>
    Option.toArray(
      Option.liftPredicate(`- ${finding.finding}`, () => finding.remediated === remediated),
    ),
  );

const reReviews = (count: number) => {
  if (count === 1) {
    return "1 re-review";
  }

  return `${count} re-reviews`;
};

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const { rounds } = yield* Settings.reviewers;
    const { pullRequest } = yield* Review.pullRequestOf(item);
    const earlier = yield* Review.latestOwnReview(pullRequest);

    // No review of its own to resume, as one posted before markers named their reviewer: review afresh.
    if (Option.isNone(earlier) || Option.isNone(Option.fromUndefinedOr(earlier.value.sessionId))) {
      return yield* reviewAfresh(pullRequest);
    }

    const round = earlier.value.round ?? 1;
    const done = round - 1;

    if (done >= rounds) {
      return yield* PullRequest.handToPerson(
        pullRequest,
        `asked to review again after ${reReviews(done)}, and reviewRounds is ${rounds}, so a person decides. Review ${round}'s findings are in its review above.`,
      );
    }

    const rechecked = yield* Review.recheck(pullRequest, earlier.value);
    yield* Review.doneReviewing(pullRequest);
    yield* PullRequest.comment(
      pullRequest,
      [
        `Review ${round}'s findings, re-reviewed.`,
        "",
        "Remediated:",
        ...listed(rechecked.findings, true),
        "",
        "Still open:",
        ...listed(rechecked.findings, false),
      ].join("\n"),
    );

    if (rechecked.verdict === "approve") {
      return yield* mergeIfShipping(pullRequest);
    }

    return yield* PullRequest.handToPerson(
      pullRequest,
      `review ${rechecked.round ?? 2} still requests changes after a round of fixes`,
    );
  }).pipe(
    // A pull request closed, or gone, while the review ran leaves nothing to do.
    Effect.catchTags({
      PullRequestClosed: (closed) => Effect.fail(new Skip({ reason: closed.message })),
      NotFound: (gone) => Effect.fail(new Skip({ reason: gone.message })),
    }),
  );

// What config.yaml may set for this flow, under settings: or flows.<name>.settings.
const settings = Schema.Struct({
  ...Routing.Settings.fields,
  ...Settings.Labels.fields,
  ...Settings.Base.fields,
  ...Settings.Rules.fields,
  ...Settings.Reviewers.fields,
  ...Settings.MergeHold.fields,
});

export default defineFlow({
  labels: Settings.declaredLabels,
  settings,
  trigger,
  concurrency: 1,
  // Its trigger finds only pull requests that ask this persona for a review.
  ownWork: true,
  // Doctor warns when a reviewer this machine acts as doesn't run it.
  doctor: [Review.reviewerCheck],
  // A pull request closed or merged ends the run as superseded.
  stillValid: Review.stillValid,
  workflow,
});
