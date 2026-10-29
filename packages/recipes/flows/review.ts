// Reviews pull requests whose review is requested of the persona this runs
// as, and that it hasn't reviewed yet. Each review runs in a fresh session of
// the reviewer role (flows.review.agents, or the persona's roles pick: a
// different agent from the one that wrote the code avoids a model approving
// its own work) and is posted as a real GitHub review. An approval of an
// auto:ship pull request merges it, when that's safe; changes requested go
// back to the author.
//
// This file is chernabog's review recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("review-1", "ships-pr-7") are the keys a
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

// Pull requests that ask this persona for a review, which it hasn't reviewed
// yet, routed by their assignees and reviewers, and those waiting on a
// reviewer no persona on this machine acts as, which status lists. Reading
// review requests needs the persona's seat in the reviewer pool, which
// chernabog checks before the flow runs.
const trigger = Effect.gen(function* () {
  const found = yield* Review.reviewRequests;

  const mine = yield* Effect.forEach(
    found.filter(({ reviewed }) => reviewed === 0),
    ({ pull }) => Review.routed(pull, Review.reviewItem(pull, `pr-${pull.number}`)),
  );

  return [...mine, ...(yield* Review.waitingElsewhere)];
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
// only when that's safe; a person merges any other. One refused because it
// conflicts with its base is left to resolve-conflicts, which merges the base
// in and asks for this review again.
const mergeIfShipping = (pullRequest: number) =>
  Effect.gen(function* () {
    if (!(yield* PullRequest.shipping(pullRequest))) {
      return `#${pullRequest} approved; a person merges`;
    }

    return yield* PullRequest.merge(pullRequest, { method: "squash" }).pipe(
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

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const { pullRequest } = yield* Review.pullRequestOf(item);
    const review = yield* Review.round(pullRequest, 1, { role: "reviewer" });
    yield* Review.doneReviewing(pullRequest);

    if (review.verdict === "approve") {
      return yield* mergeIfShipping(pullRequest);
    }

    // The author's address-review picks the pull request up from the review itself.
    return `#${pullRequest}: review 1 requested changes`;
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
