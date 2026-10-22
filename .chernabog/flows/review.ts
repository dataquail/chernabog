// Reviews pull requests whose review is requested of the persona this runs
// as, and that it hasn't reviewed yet. Each review runs in a fresh session of
// the reviewer role (flows.review.agents, or the persona's roles pick: a
// different agent from the one that wrote the code avoids a model approving
// its own work) and is posted as a real GitHub review. An approval of an
// auto:ship pull request merges it, when that's safe; changes requested go
// back to the author.
//
// This file is chernabog's review recipe, and this repo's to change. The
// names of its steps ("review-1", "ships-pr-7") are the keys a run in flight
// resumes by, so renaming one restarts that step.

import { defineFlow, PullRequest, Review, type WorkItem } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

// Pull requests that ask this persona for a review, which it hasn't reviewed yet.
const trigger = Effect.map(Review.reviewRequests, (found) =>
  found.flatMap(({ pull, reviewed }) => Option.toArray(Option.liftPredicate(Review.reviewItem(pull, `pr-${pull.number}`), () => reviewed === 0))),
);

// Chernabog merges only pull requests on the automated path (auto:ship), and
// only when that's safe; a person merges any other.
const mergeIfShipping = (pullRequest: number) =>
  Effect.gen(function* () {
    if (!(yield* PullRequest.shipping(pullRequest))) return `#${pullRequest} approved; a person merges`;

    return yield* PullRequest.merge(pullRequest, { method: 'squash' }).pipe(Effect.catchTag('NeedsHuman', (refused) => PullRequest.handToPerson(pullRequest, refused.reason)));
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const { pullRequest } = yield* Review.pullRequestOf(item);
    const review = yield* Review.round(pullRequest, 1, { role: 'reviewer' });
    yield* Review.doneReviewing(pullRequest);

    if (review.verdict === 'approve') return yield* mergeIfShipping(pullRequest);

    // The author's address-review picks the pull request up from the review itself.
    return `#${pullRequest}: review 1 requested changes`;
  });

export default defineFlow({
  trigger,
  concurrency: 1,
  // Its trigger finds only pull requests that ask this persona for a review.
  ownWork: true,
  workflow,
});
