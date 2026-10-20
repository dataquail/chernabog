// The SDK's steps and triggers against an in-memory GitHub: which of them move
// labels, which leave that to a separate step, and who owns a pull request.

import { fileURLToPath } from 'node:url';

import { Agent, awaitSignal, type Comment, DEFAULT_LABELS, defineFlow, Git, GitHub, HEADLESS, Implement, type Issue, NeedsHuman, ownerMarker, PullRequest, Repo, type RepoSettings, Review, reviewMarker, Runs, StepRunner, Usage, type WorkItem, Worktree } from '@chernabog/sdk';
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
import { type RunRow, State } from '../src/state.ts';
import { effect } from './effect-test.ts';

const PULL = 7;
const ISSUE = 3;
const HEAD = 'abc1234def';
const SHIP = 'auto:ship';

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
const makeFake = (verdict: 'approve' | 'request-changes', overrides: Partial<RepoSettings> = {}) => {
  const labels = new Map<number, Array<string>>([
    [PULL, [DEFAULT_LABELS.needsReview]],
    [ISSUE, [DEFAULT_LABELS.inProgress]],
  ]);

  const comments: Array<Comment> = [];
  const reviews: Array<string> = [];
  const adapters: Array<Option.Option<string>> = [];
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

  const issue = (): Issue => ({ number: ISSUE, title: 'A queued issue', body: '', url: `https://github.com/dataquail/demo/issues/${ISSUE}`, createdAt: '2026-10-20T00:00:00Z', labels: labelsOf(ISSUE), assignees: [] });

  // What this machine knows of the run that owns the pull request: nothing, unless a test says.
  let knownRun = Option.none<boolean>();

  const knowRun = (active: boolean) => {
    knownRun = Option.some(active);
  };

  const setLabels = (number: number, names: Array<string>) => {
    labels.set(number, names);
  };

  const comment = (body: string) => {
    comments.push({ id: comments.length + 1, author: 'chernabog-bot', body, createdAt: '2026-10-20T00:00:00Z', trusted: true });
  };

  const services = Layer.mergeAll(
    Layer.succeed(Repo, Repo.of({ ...settings, ...overrides })),
    Layer.mock(GitHub)({
      queuedIssuesLabelled: (label) => Effect.succeed([issue()].filter((queued) => queued.labels.includes(label))),
      issue: () => Effect.succeed(issue()),
      branchSha: () => Effect.succeedSome('base1234'),
      createBranch: () => Effect.succeed('created' as const),
      assignSelf: () => Effect.void,
      moveToStatus: () => Effect.void,
      pullRequestsLabelled: (label) => Effect.succeed([pull()].filter((open) => open.labels.includes(label))),
      closedPullRequestsLabelled: () => Effect.succeed([]),
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
    Layer.mock(Agent)({
      adapters: [],
      run: (request) =>
        Effect.sync(() => {
          adapters.push(request.adapter);

          return { sessionId: request.sessionId, output: { verdict, summary: 'Reviewed.', comments: [] }, costUsd: Option.none() };
        }),
    }),
    Layer.mock(StepRunner)({}),
    Layer.succeed(Runs, Runs.of({ isActive: () => Effect.sync(() => knownRun) })),
  );

  return { services, knowRun, labelsOf, setLabels, comments, reviews, adapters, comment };
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

      if (work.key === 'round-as-reviewer') return (yield* Review.round(PULL, 1, { role: 'reviewer' })).verdict;

      if (work.key === 'round-then-label') {
        const review = yield* Review.round(PULL, 1);
        yield* Review.labelVerdict(PULL, 1, review);

        return review.verdict;
      }

      if (work.key === 'stale-label') return yield* Review.labelVerdict(PULL, 1, { verdict: 'request-changes', sha: HEAD });

      if (work.key === 'review-round') return (yield* Review.reviewRound(PULL, 1)).verdict;

      if (work.key === 'hand-off') return yield* Implement.handOff(ISSUE, opened, outcome);

      if (work.key === 'claim-ship') return (yield* Implement.claim(ISSUE, { label: SHIP })).branch;

      if (work.key === 'owning') return yield* PullRequest.owning(PULL)(Review.round(PULL, 1)).pipe(Effect.map((review) => review.verdict));

      if (work.key === 'owning-fails') return yield* PullRequest.owning(PULL)(Effect.fail(new NeedsHuman({ reason: 'stuck' })));

      if (work.key === 'owning-waits') return yield* PullRequest.owning(PULL)(awaitSignal(['pushed'], { id: 'wait', timeout: '1 hour' }));

      if (work.key === 'hand-off-unlabelled') return yield* Implement.handOff(ISSUE, opened, outcome, { needsReview: false });
    }),
});

const handle = flowHandle(repo, 'demo', flow);

const item = (key: string): WorkItem => ({ key, data: {} });

const isRunning = (run: RunRow) => run.status === 'running';

// Starts the run, and polls until `until` says it has got far enough.
const runUntil = (fake: Fake, key: string, until: (run: RunRow) => Effect.Effect<boolean, never, State>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-steps-' });
    const engine = yield* Layer.build(flowLayer(handle, fake.services).pipe(Layer.provideMerge(StateAt(homePaths(home).state)), Layer.provideMerge(Home.at(home, home))));
    const platform = yield* Effect.context<BunServices.BunServices>();

    const run = startRun(handle, item(key)).pipe(
      Effect.flatMap((started) => Effect.fromOption(started.run)),
      Effect.flatMap((started) =>
        pollRun(handle, started).pipe(
          Effect.flatMap((polled) => until(polled).pipe(Effect.map((done) => ({ polled, done })))),
          Effect.repeat({ schedule: Schedule.spaced('25 millis'), until: (step) => step.done, times: 200 }),
        ),
      ),
      Effect.map((step) => step.polled),
      Effect.orDie,
    );

    return yield* Effect.provideContext(run, Context.merge(platform, engine));
  });

// Runs a trigger against the fake, as a tick would.
const triggered = <E, R>(fake: Fake, trigger: Effect.Effect<ReadonlyArray<WorkItem>, E, R>) => Effect.provide(trigger, fake.services);

const runToEnd = (fake: Fake, key: string) => runUntil(fake, key, (run) => Effect.succeed(!isRunning(run)));

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

describe('agents per role', () => {
  const roles = { flowAgents: { demo: 'opencode' }, flowRoleAgents: { demo: { reviewer: 'codex' } } };

  effect(
    "a step given a role runs with that role's adapter",
    () => Effect.gen(function* () {
      const fake = makeFake('approve', roles);
      expect((yield* runToEnd(fake, 'round-as-reviewer')).status).toBe('done');
      expect(fake.adapters).toEqual([Option.some('codex')]);
      expect(fake.reviews[0]).toContain('Approved by codex');
    }),
  );

  effect(
    "a step without a role, or with one the flow does not name, falls back to the flow's agent",
    () => Effect.gen(function* () {
      const plain = makeFake('approve', roles);
      expect((yield* runToEnd(plain, 'round')).status).toBe('done');
      const unnamed = makeFake('approve', { ...roles, flowRoleAgents: { demo: { author: 'codex' } } });
      expect((yield* runToEnd(unnamed, 'round-as-reviewer')).status).toBe('done');
      expect([...plain.adapters, ...unnamed.adapters]).toEqual([Option.some('opencode'), Option.some('opencode')]);
    }),
  );

  effect(
    "and with no flow agent either, the repo's",
    () => Effect.gen(function* () {
      const fake = makeFake('approve');
      expect((yield* runToEnd(fake, 'round-as-reviewer')).status).toBe('done');
      expect(fake.adapters).toEqual([Option.none()]);
      expect(fake.reviews[0]).toContain('Approved by claude');
    }),
  );
});

describe('a flow keyed by its own label', () => {
  effect(
    'Implement.triggerFor finds issues with that label, and claim takes the label off',
    () => Effect.gen(function* () {
      const fake = makeFake('approve');
      fake.setLabels(ISSUE, [SHIP]);
      const found = yield* triggered(fake, Implement.triggerFor(SHIP));
      expect(found.map((work) => work.key)).toEqual([`issue-${ISSUE}`]);
      expect(yield* triggered(fake, Implement.trigger)).toEqual([]);

      expect((yield* runToEnd(fake, 'claim-ship')).status).toBe('done');
      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.inProgress]);
    }),
  );
});

const ownership = (fake: Fake) => fake.comments.flatMap((comment) => Option.toArray(ownerMarker.read(comment.body))).map((marker) => marker.released);

describe('owning a pull request', () => {
  effect(
    'PullRequest.owning marks the pull request as the run\'s, and lets it go when the run ends',
    () => Effect.gen(function* () {
      const done = makeFake('approve');
      expect((yield* runToEnd(done, 'owning')).status).toBe('done');
      expect(ownership(done)).toEqual([false, true]);

      const failed = makeFake('approve');
      expect((yield* runToEnd(failed, 'owning-fails')).status).toBe('needs-human');
      expect(ownership(failed)).toEqual([false, true]);
    }),
  );

  effect(
    'a run waiting on a signal keeps the pull request',
    () => Effect.gen(function* () {
      const fake = makeFake('approve');
      yield* runUntil(fake, 'owning-waits', (run) => State.use((state) => state.waitsFor(run.id, 'pushed')).pipe(Effect.map((waits) => waits.length > 0)));
      expect(ownership(fake)).toEqual([false]);
    }),
  );

  const owned = (fake: Fake, released: boolean) => {
    fake.comment(ownerMarker.write({ flow: 'ship', runId: 'demo.ship.issue-3.1', released }));
  };

  effect(
    'the review and fix triggers leave alone a pull request another run owns',
    () => Effect.gen(function* () {
      const review = makeFake('approve');
      owned(review, false);
      expect(yield* triggered(review, Review.trigger)).toEqual([]);

      const fix = makeFake('approve');
      fix.setLabels(PULL, [DEFAULT_LABELS.changesRequested]);
      fix.comment(reviewMarker.write({ sha: HEAD, round: 1, verdict: 'request-changes' }));
      expect((yield* triggered(fix, Review.fixTrigger)).length).toBe(1);
      owned(fix, false);
      expect(yield* triggered(fix, Review.fixTrigger)).toEqual([]);
    }),
  );

  effect(
    'and pick it up again once the run lets go, or this machine knows the run ended',
    () => Effect.gen(function* () {
      const released = makeFake('approve');
      owned(released, false);
      owned(released, true);
      expect((yield* triggered(released, Review.trigger)).map((work) => work.key)).toEqual([`pr-${PULL}`]);

      // A run this machine doesn't know, such as one on another machine, still owns it.
      const ended = makeFake('approve');
      owned(ended, false);
      expect(yield* triggered(ended, Review.trigger)).toEqual([]);
      ended.knowRun(false);
      expect((yield* triggered(ended, Review.trigger)).map((work) => work.key)).toEqual([`pr-${PULL}`]);
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
