// The review and re-review flows end to end through the engine, on an
// in-memory GitHub: who they pick up, the reviews they post, and where each
// ending leaves the pull request.

import { DEFAULT_LABELS, Review, reviewMarker, type WorkItem } from '@chernabog/sdk';
import { describe, expect } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { flowHandle } from '../src/engine.ts';
import reReview from '../templates/.chernabog/flows/re-review.ts';
import review from '../templates/.chernabog/flows/review.ts';
import { effect } from './effect-test.ts';
import { type Fake, HEAD, item, makeFake, PULL, repo, runToEnd, summaryOf, triggered, type Verdict } from './sdk-fakes.ts';

const reviewing = flowHandle(repo, 'review', review);
const reReviewing = flowHandle(repo, 're-review', reReview);
const work = item(`pr-${PULL}`, { pullRequest: PULL, headRef: 'auto/issue-3', agentWritten: true });

// A pull request that asks data-quail, the persona these runs act as, for a
// review; its reviews answer `verdicts` in turn.
const asked = (verdicts: ReadonlyArray<Verdict>, labels: ReadonlyArray<string> = []) => {
  const fake = makeFake(verdicts);
  fake.people.me = 'data-quail';
  fake.people.requested = ['data-quail'];
  fake.setLabels(PULL, [...labels]);

  return fake;
};

const askAgain = (fake: Fake) => {
  fake.people.requested = ['data-quail'];
};

const keys = <E, R>(fake: Fake, trigger: Effect.Effect<ReadonlyArray<WorkItem>, E, R>) => Effect.map(triggered(fake, trigger), (items) => items.map((found) => found.key));

describe('review', () => {
  effect('picks up a pull request whose review is requested of this persona, until it has reviewed it', () =>
    Effect.gen(function* () {
      const fake = asked(['approve']);
      expect(yield* keys(fake, Review.trigger)).toEqual([`pr-${PULL}`]);
      expect(yield* keys(fake, Review.reReviewTrigger)).toEqual([]);

      fake.people.me = 'zach';
      expect(yield* keys(fake, Review.trigger)).toEqual([]);
    }),
  );

  effect('posts a real approval, and leaves a pull request off the automated path for a person to merge', () =>
    Effect.gen(function* () {
      const fake = asked(['approve']);
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(finished.status).toBe('done');
      expect(summaryOf(finished)).toBe(`#${PULL} approved; a person merges`);
      expect(fake.submitted).toEqual([{ author: 'data-quail', state: 'APPROVED', commitSha: HEAD }]);
      expect(fake.merge.requests).toEqual([]);
      expect(fake.people.requested).toEqual([]);
    }),
  );

  effect('merges an approved auto:ship pull request, when that is safe', () =>
    Effect.gen(function* () {
      const fake = asked(['approve'], [DEFAULT_LABELS.ship]);
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);
      expect(fake.merge.requests).toEqual([{ method: 'squash', sha: HEAD }]);
    }),
  );

  effect('hands an approved auto:ship pull request it may not merge to a person', () =>
    Effect.gen(function* () {
      const fake = asked(['approve'], [DEFAULT_LABELS.ship]);
      fake.merge.ci = { state: 'red', failedChecks: ['test'] };
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(finished.status).toBe('needs-human');
      expect(summaryOf(finished)).toContain('not merged: checks failed: test');
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect('requests changes as a real review, for the author to answer', () =>
    Effect.gen(function* () {
      const fake = asked(['request-changes']);
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(summaryOf(finished)).toBe(`#${PULL}: review 1 requested changes`);
      expect(fake.submitted.map((submitted) => submitted.state)).toEqual(['CHANGES_REQUESTED']);
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.changesRequested]);
    }),
  );
});

describe('re-review', () => {
  // Reviewed once with changes requested, then asked again after a push.
  const reviewedOnce = (verdicts: ReadonlyArray<Verdict>, labels: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const fake = asked(['request-changes', ...verdicts], labels);
      yield* runToEnd(reviewing, fake, work);
      fake.git.head = 'fix20000000';
      askAgain(fake);

      return fake;
    });

  effect('picks up a pull request this persona reviewed and is asked about again, unless a person has it', () =>
    Effect.gen(function* () {
      const fake = yield* reviewedOnce(['approve']);
      expect(yield* keys(fake, Review.reReviewTrigger)).toEqual([`pr-${PULL}-review-2`]);
      expect(yield* keys(fake, Review.trigger)).toEqual([]);

      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      expect(yield* keys(fake, Review.reReviewTrigger)).toEqual([]);
    }),
  );

  effect('resumes its own review session, and an approval of an auto:ship pull request merges it', () =>
    Effect.gen(function* () {
      const fake = yield* reviewedOnce(['approve'], [DEFAULT_LABELS.ship]);
      const finished = yield* runToEnd(reReviewing, fake, item(`pr-${PULL}-review-2`, { pullRequest: PULL, headRef: 'auto/issue-3', agentWritten: true }));
      expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);

      const [first, again] = fake.requests;
      expect(again.sessionId).toBe(first.sessionId);
      expect(Option.isSome(again.resumePrompt)).toBe(true);
      expect(fake.submitted.map((submitted) => submitted.state)).toEqual(['CHANGES_REQUESTED', 'APPROVED']);
      expect(fake.merge.requests).toEqual([{ method: 'squash', sha: 'fix20000000' }]);
      expect(fake.comments.some((comment) => comment.body.includes("Review 1's findings, re-reviewed."))).toBe(true);
    }),
  );

  effect('requests changes again and hands the pull request to a person', () =>
    Effect.gen(function* () {
      const fake = yield* reviewedOnce(['request-changes'], [DEFAULT_LABELS.ship]);
      const finished = yield* runToEnd(reReviewing, fake, item(`pr-${PULL}-review-2`, { pullRequest: PULL, headRef: 'auto/issue-3', agentWritten: true }));
      expect(finished.status).toBe('needs-human');
      expect(summaryOf(finished)).toContain('review 2 still requests changes');
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect('stops past limits.reviewRounds, without another review', () =>
    Effect.gen(function* () {
      const fake = asked(['approve']);
      fake.comment(reviewMarker.write({ sha: HEAD, round: 2, verdict: 'request-changes', reviewer: 'data-quail', sessionId: 'earlier-session', adapter: 'claude' }));
      const finished = yield* runToEnd(reReviewing, fake, item(`pr-${PULL}-review-3`, { pullRequest: PULL, headRef: 'auto/issue-3', agentWritten: true }));
      expect(finished.status).toBe('needs-human');
      expect(summaryOf(finished)).toContain('after 1 re-review, and limits.reviewRounds is 1');
      expect(fake.requests).toEqual([]);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );
});
