// A composite flow end to end through the engine: the `ship` flow from the docs
// implements, reviews with its reviewer role, answers the review in the
// implement session, has the reviewer re-check, and merges or hands off.

import { DEFAULT_LABELS, ownerMarker, reviewMarker } from '@chernabog/sdk';
import { describe, expect } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { flowHandle } from '../src/engine.ts';
import { effect } from './effect-test.ts';
import { type Fake, HEAD, ISSUE, item, makeFake, PULL, repo, runToEnd, summaryOf, type Verdict } from './sdk-fakes.ts';
import ship from './ship-flow.ts';

const handle = flowHandle(repo, 'ship', ship);

const SHIP = 'auto:ship';

// An issue labelled auto:ship and no pull request yet; the flow's reviewer is Codex.
const shipping = (verdicts: ReadonlyArray<Verdict>) => {
  const fake = makeFake(verdicts, { flowRoleAgents: { ship: { reviewer: 'codex' } } });
  fake.setLabels(ISSUE, [SHIP]);
  fake.setLabels(PULL, []);

  return fake;
};

const runShip = (fake: Fake) => runToEnd(handle, fake, item(`issue-${ISSUE}`, { issue: ISSUE }));

const ownership = (fake: Fake) => fake.comments.flatMap((comment) => Option.toArray(ownerMarker.read(comment.body))).map((marker) => marker.released);

const reviewRounds = (fake: Fake) => fake.comments.flatMap((comment) => Option.toArray(reviewMarker.read(comment.body))).map((marker) => `${marker.round}:${marker.verdict}@${marker.sha.slice(0, 4)}`);

// Which session each agent call went to: the implement session, which the first call opened, or another.
const sessions = (fake: Fake) =>
  fake.requests.map((request) => {
    const adapter = Option.getOrElse(request.adapter, () => 'repo');

    if (request.sessionId === fake.requests[0]?.sessionId) return `author:${adapter}`;

    return `reviewer:${adapter}`;
  });

describe('a composite ship flow', () => {
  effect(
    'implements, has its reviewer approve, and merges, without the review flow or a needs-review label',
    () => Effect.gen(function* () {
      const fake = shipping(['approve']);
      const finished = yield* runShip(fake);
      expect(finished.status).toBe('done');
      expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);
      expect(fake.merge.requests).toEqual([{ method: 'squash', sha: HEAD }]);
      expect(sessions(fake)).toEqual(['author:repo', 'reviewer:codex']);
      expect(reviewRounds(fake)).toEqual([`1:approve@${HEAD.slice(0, 4)}`]);
      expect(ownership(fake)).toEqual([false, true]);
      // The label contract: the queue label is gone, nothing is in progress, and the pull request carries no label for another flow.
      expect(fake.labelsOf(ISSUE)).toEqual([]);
      expect(fake.labelsOf(PULL)).toEqual([]);
    }),
  );

  effect(
    'answers changes in the session that wrote the code, has the reviewer re-check, and merges the fixed head',
    () => Effect.gen(function* () {
      const fake = shipping(['request-changes', 'approve']);
      const finished = yield* runShip(fake);
      expect(finished.status).toBe('done');
      expect(fake.merge.requests).toEqual([{ method: 'squash', sha: fake.git.head }]);
      expect(fake.git.head).not.toBe(HEAD);
      // Implement, review, consider, address, re-check: two sessions throughout.
      expect(sessions(fake)).toEqual(['author:repo', 'reviewer:codex', 'author:repo', 'author:repo', 'reviewer:codex']);
      expect(reviewRounds(fake)).toEqual([`1:request-changes@${HEAD.slice(0, 4)}`, `2:approve@${fake.git.head.slice(0, 4)}`]);
      expect(ownership(fake)).toEqual([false, true]);
      expect(fake.labelsOf(PULL)).toEqual([]);
    }),
  );

  effect(
    'hands the issue and pull request to a person when the re-check still asks for changes, and lets the pull request go',
    () => Effect.gen(function* () {
      const fake = shipping(['request-changes', 'request-changes']);
      const finished = yield* runShip(fake);
      expect(finished.status).toBe('needs-human');
      expect(summaryOf(finished)).toContain('still changes requested after one fix round');
      expect(fake.merge.requests).toEqual([]);
      expect(ownership(fake)).toEqual([false, true]);
      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsHuman]);
    }),
  );

  effect(
    'when the author declines the review, says why on the pull request and hands it to a person',
    () => Effect.gen(function* () {
      const fake = shipping(['request-changes']);
      fake.author.consider = 'decline';
      const finished = yield* runShip(fake);
      expect(finished.status).toBe('needs-human');
      expect(summaryOf(finished)).toContain('the author declined review 1');
      expect(fake.comments.some((comment) => comment.body.startsWith('Not addressing review 1'))).toBe(true);
      expect(fake.git.pushes).toBe(1);
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsHuman]);
    }),
  );
});
