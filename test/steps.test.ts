// The SDK's review and hand-off steps against an in-memory GitHub: which of
// them move labels, and which leave that to a separate step.

import { fileURLToPath } from 'node:url';

import { Agent, type Comment, DEFAULT_LABELS, defineFlow, Git, GitHub, HEADLESS, Implement, type PullRequest, Repo, type RepoSettings, Review, reviewMarker, StepRunner, Usage, type WorkItem, Worktree } from '@chernabog/sdk';
import type { BunServices } from '@effect/platform-bun';
import { describe, expect } from 'bun:test';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';

import { Home, homePaths } from '../src/config.ts';
import { flowHandle, flowLayer, pollRun, startRun, StateAt } from '../src/engine.ts';
import { DEFAULT_LIMITS, type EffectiveRepo } from '../src/repo-config.ts';
import type { RunRow } from '../src/state.ts';
import { effect } from './effect-test.ts';

const PULL = 7;
const ISSUE = 3;
const HEAD = 'abc1234def';

const settings: RepoSettings = {
  name: 'demo',
  slug: 'dataquail/demo',
  path: '/tmp/demo',
  baseBranch: 'main',
  account: { name: 'work', configDir: Option.none(), expectedEmail: Option.none(), oauthTokenEnv: Option.none<string>(), usageGate: 'usage' as const },
  agent: 'claude',
  agentAccounts: {},
  launcher: HEADLESS,
  flowAgents: {},
  labels: DEFAULT_LABELS,
  install: Option.none(),
  localGate: [],
  humanOnly: [],
  humanOnlyPaths: [],
  notes: [],
  board: Option.none(),
  reviewTrigger: Option.none(),
  limits: DEFAULT_LIMITS,
  env: {},
  // The scaffolded prompts, which the review step renders.
  configDir: fileURLToPath(new URL('../templates/.chernabog', import.meta.url)),
};

const repo: EffectiveRepo = { settings, enabled: true, schedule: { local: Option.none(), repo: Option.none() }, activeHours: Option.none(), flows: {}, runners: { repo: Option.none(), flows: {} }, localEnabled: {} };

// One pull request and one issue, and what the steps did to them.
const makeFake = (verdict: 'approve' | 'request-changes') => {
  const labels = new Map<number, Array<string>>([
    [PULL, [DEFAULT_LABELS.needsReview]],
    [ISSUE, [DEFAULT_LABELS.inProgress]],
  ]);

  const comments: Array<Comment> = [];
  const reviews: Array<string> = [];
  const labelsOf = (number: number) => labels.get(number) ?? [];

  const pull = (): PullRequest => ({
    number: PULL,
    title: 'feat: a change',
    body: '',
    url: `https://github.com/dataquail/demo/pull/${PULL}`,
    state: 'open',
    headRef: 'auto/issue-3',
    headSha: HEAD,
    baseRef: 'main',
    labels: labelsOf(PULL),
    author: 'chernabog-bot',
    assignees: [],
    requestedReviewers: [],
  });

  const comment = (body: string) => {
    comments.push({ id: comments.length + 1, author: 'chernabog-bot', body, createdAt: '2026-10-20T00:00:00Z', trusted: true });
  };

  const services = Layer.mergeAll(
    Layer.succeed(Repo, settings),
    Layer.mock(GitHub)({
      pullRequest: () => Effect.succeed(pull()),
      comments: () => Effect.succeed([...comments]),
      reviewComments: () => Effect.succeed([]),
      comment: (_, body) =>
        Effect.sync(() => {
          comment(body);
        }),
      review: (_, review) =>
        Effect.sync(() => {
          reviews.push(review.body);
        }),
      addLabel: (number, label) =>
        Effect.sync(() => {
          labels.set(number, [...labelsOf(number).filter((name) => name !== label), label]);
        }),
      removeLabel: (number, label) =>
        Effect.sync(() => {
          labels.set(number, labelsOf(number).filter((name) => name !== label));
        }),
    }),
    Layer.mock(Git)({}),
    Layer.mock(Worktree)({ pathFor: (branch) => `/tmp/demo-worktrees/${branch}`, checkout: (name) => Effect.succeed(`/tmp/demo-worktrees/${name}`) }),
    Layer.mock(Usage)({}),
    Layer.mock(Agent)({ adapters: [], run: (request) => Effect.succeed({ sessionId: request.sessionId, output: { verdict, summary: 'Reviewed.', comments: [] }, costUsd: Option.none() }) }),
    Layer.mock(StepRunner)({}),
  );

  return { services, labelsOf, comments, reviews, comment };
};

type Fake = ReturnType<typeof makeFake>;

const outcome = { status: 'done' as const, summary: 'Did it.', title: 'feat: a change', body: 'The change.' };

const opened = { number: PULL, url: `https://github.com/dataquail/demo/pull/${PULL}` };

// Each item key names the steps its run takes.
const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    Effect.gen(function* () {
      if (work.key === 'round') return (yield* Review.round(PULL, 1)).verdict;

      if (work.key === 'round-then-label') {
        const review = yield* Review.round(PULL, 1);
        yield* Review.labelVerdict(PULL, 1, review);

        return review.verdict;
      }

      if (work.key === 'stale-label') return yield* Review.labelVerdict(PULL, 1, { verdict: 'request-changes', sha: HEAD });

      if (work.key === 'review-round') return (yield* Review.reviewRound(PULL, 1)).verdict;

      if (work.key === 'hand-off') return yield* Implement.handOff(ISSUE, opened, outcome);

      if (work.key === 'hand-off-unlabelled') return yield* Implement.handOff(ISSUE, opened, outcome, { needsReview: false });
    }),
});

const handle = flowHandle(repo, 'demo', flow);

const item = (key: string): WorkItem => ({ key, data: {} });

const isRunning = (run: RunRow) => run.status === 'running';

const runToEnd = (fake: Fake, key: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-steps-' });
    const engine = yield* Layer.build(flowLayer(handle, fake.services).pipe(Layer.provideMerge(StateAt(homePaths(home).state)), Layer.provideMerge(Home.at(home, home))));
    const platform = yield* Effect.context<BunServices.BunServices>();

    const run = startRun(handle, item(key)).pipe(
      Effect.flatMap((started) => Effect.fromOption(started.run)),
      Effect.flatMap((started) => pollRun(handle, started).pipe(Effect.repeat({ schedule: Schedule.spaced('25 millis'), while: isRunning, times: 200 }))),
      Effect.orDie,
    );

    return yield* Effect.provideContext(run, Context.merge(platform, engine));
  });

const summaryOf = (run: RunRow) => Option.getOrElse(run.summary, () => '');

describe('the review steps', () => {
  effect(
    'Review.round posts the review and its marker, and leaves the labels alone',
    () => Effect.gen(function* () {
      const fake = makeFake('request-changes');
      const finished = yield* runToEnd(fake, 'round');
      expect(finished.status).toBe('done');
      expect(summaryOf(finished)).toBe('request-changes');
      expect(fake.reviews).toHaveLength(1);
      expect(fake.comments.map((comment) => comment.body).some((body) => Option.isSome(reviewMarker.read(body)))).toBe(true);
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
    }),
  );

  effect(
    'Review.labelVerdict then moves them as the review said',
    () => Effect.gen(function* () {
      const fake = makeFake('approve');
      expect((yield* runToEnd(fake, 'round-then-label')).status).toBe('done');
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.approved]);
    }),
  );

  effect(
    'Review.labelVerdict leaves the labels alone once a later review is the latest',
    () => Effect.gen(function* () {
      const fake = makeFake('request-changes');
      fake.comment(reviewMarker.write({ sha: HEAD, round: 1, verdict: 'request-changes' }));
      fake.comment(reviewMarker.write({ sha: 'fedcba9876', round: 2, verdict: 'approve' }));
      expect((yield* runToEnd(fake, 'stale-label')).status).toBe('done');
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
    }),
  );

  effect(
    'Review.reviewRound still reviews and moves the labels in one step',
    () => Effect.gen(function* () {
      const fake = makeFake('request-changes');
      expect((yield* runToEnd(fake, 'review-round')).status).toBe('done');
      expect(fake.reviews).toHaveLength(1);
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.changesRequested]);
    }),
  );
});

describe('Implement.handOff', () => {
  effect(
    'labels the pull request needs-review by default',
    () => Effect.gen(function* () {
      const fake = makeFake('approve');
      fake.labelsOf(PULL).splice(0);
      expect((yield* runToEnd(fake, 'hand-off')).status).toBe('done');
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
      expect(fake.labelsOf(ISSUE)).toEqual([]);
    }),
  );

  effect(
    'leaves needs-review off when the flow reviews the pull request itself',
    () => Effect.gen(function* () {
      const fake = makeFake('approve');
      fake.labelsOf(PULL).splice(0);
      expect((yield* runToEnd(fake, 'hand-off-unlabelled')).status).toBe('done');
      expect(fake.labelsOf(PULL)).toEqual([]);
      expect(fake.labelsOf(ISSUE)).toEqual([]);
      expect(fake.comments.map((comment) => comment.body).some((body) => body.includes('chernabog-session'))).toBe(true);
    }),
  );
});
