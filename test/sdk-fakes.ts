// An in-memory repo for running SDK steps and whole flows through the engine:
// one issue, the pull request a flow opens for it, the git and CI behind it,
// and an agent that answers whatever shape a step asks for.

import { fileURLToPath } from 'node:url';

import {
  Agent,
  type AgentRequest,
  type CiState,
  type Comment,
  DEFAULT_LABELS,
  Git,
  GitHub,
  HEADLESS,
  type Issue,
  type Json,
  type MergeOutcome,
  type MergeRequest,
  printJson,
  type PullRequest,
  Repo,
  type RepoSettings,
  Runs,
  StepRunner,
  Usage,
  type WorkItem,
  Worktree,
} from '@chernabog/sdk';
import type { BunServices } from '@effect/platform-bun';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';

import { Home, homePaths } from '../src/config.ts';
import { type FlowHandle, flowLayer, pollRun, startRun, StateAt } from '../src/engine.ts';
import { DEFAULT_LIMITS, type EffectiveRepo } from '../src/repo-config.ts';
import type { RunRow, State } from '../src/state.ts';

export const PULL = 7;
export const ISSUE = 3;

// The head the first push makes; each later push moves it.
export const HEAD = 'abc1234def';

export const settings: RepoSettings = {
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
  humanOnlyPaths: ['.github/**'],
  notes: [],
  board: Option.none(),
  reviewTrigger: Option.none(),
  limits: DEFAULT_LIMITS,
  env: {},
  // The scaffolded prompts, which the implement and review steps render.
  configDir: fileURLToPath(new URL('../templates/.chernabog', import.meta.url)),
};

export const repo: EffectiveRepo = { settings, enabled: true, schedule: { local: Option.none(), repo: Option.none() }, activeHours: Option.none(), flows: {}, runners: { repo: Option.none(), flows: {} }, localEnabled: {}, personas: [Option.none()] };

export type Verdict = 'approve' | 'request-changes';

// CI on the head, the files the pull request changes, whether GitHub refuses the merge, and the merges asked for.
export type MergeFake = { ci: CiState; files: Array<string>; refusal: Option.Option<string>; requests: Array<MergeRequest> };

// One issue and its pull request, and what the steps did to them. Reviews
// answer `verdicts` in turn, the last one repeating.
export const makeFake = (verdicts: Verdict | ReadonlyArray<Verdict>, overrides: Partial<RepoSettings> = {}) => {
  const queue = [verdicts].flat();

  const labels = new Map<number, Array<string>>([
    [PULL, [DEFAULT_LABELS.needsReview]],
    [ISSUE, [DEFAULT_LABELS.inProgress]],
  ]);

  const comments: Array<Comment> = [];
  const reviews: Array<string> = [];
  const adapters: Array<Option.Option<string>> = [];
  const requests: Array<AgentRequest> = [];
  const labelsOf = (number: number) => labels.get(number) ?? [];
  const merge: MergeFake = { ci: { state: 'green' }, files: ['src/a.ts'], refusal: Option.none(), requests: [] };
  const git = { head: HEAD, pushes: 0, opened: false };
  // How the author answers a review it is asked to consider.
  const author = { consider: 'address' };
  let reviewed = 0;

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

  const nextVerdict = () => {
    reviewed += 1;

    return queue[Math.min(reviewed, queue.length) - 1] ?? 'approve';
  };

  // What the agent answers, by the shape the step asked for.
  const answerFor = (request: AgentRequest): Json => {
    const schema = Option.match(request.outputSchema, { onNone: () => '', onSome: printJson });

    if (schema.includes('remediated')) return { verdict: nextVerdict(), summary: 'Both fixed.', comments: [], findings: [{ finding: 'Mention the change', remediated: true }] };

    if (schema.includes('decline')) return { status: author.consider, reasons: 'The review is right.' };

    if (schema.includes('needs-clarification')) return { status: 'done', summary: 'Mentioned the change.', title: 'feat: a change', body: 'The change.' };

    return { verdict: nextVerdict(), summary: 'Reviewed.', comments: [{ path: 'README.md', line: 1, body: 'Mention the change.' }] };
  };

  const pull = (): PullRequest => ({
    number: PULL,
    title: 'feat: a change',
    body: '',
    url: `https://github.com/dataquail/demo/pull/${PULL}`,
    state: 'open',
    headRef: `auto/issue-${ISSUE}`,
    headSha: git.head,
    baseRef: 'main',
    labels: labelsOf(PULL),
    author: 'chernabog-bot',
    assignees: [],
    requestedReviewers: [],
  });

  const issue = (): Issue => ({ number: ISSUE, title: 'A queued issue', body: '', url: `https://github.com/dataquail/demo/issues/${ISSUE}`, createdAt: '2026-10-20T00:00:00Z', labels: labelsOf(ISSUE), assignees: [] });

  const services = Layer.mergeAll(
    Layer.succeed(Repo, Repo.of({ ...settings, ...overrides })),
    Layer.mock(GitHub)({
      queuedIssuesLabelled: (label) => Effect.succeed([issue()].filter((queued) => queued.labels.includes(label))),
      issue: () => Effect.succeed(issue()),
      trustedComments: () => Effect.succeed([]),
      branchSha: () => Effect.succeedSome('base1234'),
      createBranch: () => Effect.succeed('created' as const),
      deleteBranch: () => Effect.void,
      assignSelf: () => Effect.void,
      moveToStatus: () => Effect.void,
      pullRequestForBranch: () => Effect.sync(() => Option.filter(Option.some(pull()), () => git.opened)),
      openPullRequest: () =>
        Effect.sync(() => {
          git.opened = true;

          return pull();
        }),
      pullRequestsLabelled: (label) => Effect.succeed([pull()].filter((open) => open.labels.includes(label))),
      closedPullRequestsLabelled: () => Effect.succeed([]),
      pullRequest: () => Effect.sync(pull),
      ciState: () => Effect.sync(() => merge.ci),
      pullRequestFiles: () => Effect.sync(() => merge.files),
      merge: (_, request) =>
        Effect.sync((): MergeOutcome => {
          merge.requests.push(request);

          return Option.match(merge.refusal, { onNone: () => ({ status: 'merged', sha: 'merged9876' }), onSome: (reason) => ({ status: 'refused', reason }) });
        }),
      comments: () => Effect.sync(() => [...comments]),
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
    Layer.mock(Git)({
      commitsAhead: () => Effect.succeed(1),
      changedFiles: () => Effect.sync(() => merge.files),
      push: () =>
        Effect.sync(() => {
          git.pushes += 1;

          if (git.pushes > 1) git.head = `fix${git.pushes}0000000`;
        }),
    }),
    Layer.mock(Worktree)({ pathFor: (branch) => `/tmp/demo-worktrees/${branch}`, ensure: (branch) => Effect.succeed(`/tmp/demo-worktrees/${branch}`), checkout: (name) => Effect.succeed(`/tmp/demo-worktrees/${name}`) }),
    Layer.mock(Usage)({}),
    Layer.mock(Agent)({
      adapters: [],
      run: (request) =>
        Effect.sync(() => {
          adapters.push(request.adapter);
          requests.push(request);

          return { sessionId: request.sessionId, output: answerFor(request), costUsd: Option.none() };
        }),
    }),
    Layer.mock(StepRunner)({}),
    Layer.succeed(Runs, Runs.of({ isActive: () => Effect.sync(() => knownRun) })),
  );

  return { services, git, author, merge, requests, knowRun, labelsOf, setLabels, comments, reviews, adapters, comment };
};

export type Fake = ReturnType<typeof makeFake>;

export const item = (key: string, data: Json = {}): WorkItem => ({ key, data });

const isRunning = (run: RunRow) => run.status === 'running';

// Starts a run of the flow on the fake, and polls until `until` says it has got far enough.
export const runUntil = (handle: FlowHandle, fake: Fake, work: WorkItem, until: (run: RunRow) => Effect.Effect<boolean, never, State>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-steps-' });
    const engine = yield* Layer.build(flowLayer(handle, fake.services).pipe(Layer.provideMerge(StateAt(homePaths(home).state)), Layer.provideMerge(Home.at(home, home))));
    const platform = yield* Effect.context<BunServices.BunServices>();

    const run = startRun(handle, work).pipe(
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

export const runToEnd = (handle: FlowHandle, fake: Fake, work: WorkItem) => runUntil(handle, fake, work, (run) => Effect.succeed(!isRunning(run)));

// Runs a trigger against the fake, as a tick would.
export const triggered = <E, R>(fake: Fake, trigger: Effect.Effect<ReadonlyArray<WorkItem>, E, R>) => Effect.provide(trigger, fake.services);

export const summaryOf = (run: RunRow) => Option.getOrElse(run.summary, () => '');
