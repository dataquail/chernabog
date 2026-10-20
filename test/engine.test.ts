import { activity, Agent, awaitSignal, DEFAULT_LABELS, defineFlow, Git, GitHub, HEADLESS, NeedsHuman, Repo, type RepoSettings, Run, RunLog, Skip, StepFailed, StepRunner, Usage, type WorkItem, Worktree } from '@chernabog/sdk';
import type { BunServices } from '@effect/platform-bun';
import { describe, expect } from 'bun:test';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';

import { Home, homePaths } from '../src/config.ts';
import { deliverSignals, flowHandle, flowLayer, pollRun, startRun, StateAt } from '../src/engine.ts';
import { DEFAULT_LIMITS, type EffectiveRepo } from '../src/repo-config.ts';
import { type RunRow, State } from '../src/state.ts';
import { effect } from './effect-test.ts';

const settings: RepoSettings = {
  name: 'demo',
  slug: 'dataquail/demo',
  path: '/tmp/demo',
  baseBranch: 'main',
  account: { name: 'work', configDir: Option.none(), expectedEmail: Option.none(), oauthTokenEnv: Option.none<string>() },
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
  configDir: '/tmp/demo/.chernabog',
};

const repo: EffectiveRepo = { settings, enabled: true, schedule: { local: Option.none(), repo: Option.none() }, activeHours: Option.none(), flows: {}, runners: { repo: Option.none(), flows: {} }, localEnabled: {} };

const item = (key: string, signals: ReadonlyArray<string> = []): WorkItem => ({ key, data: { key }, signals });

const executed: Array<string> = [];

const ItemData = Schema.Struct({ key: Schema.String });

const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    Effect.gen(function* () {
      const { key } = yield* Schema.decodeUnknownEffect(ItemData)(work.data).pipe(Effect.orDie);
      // Each activity sees the run's own services, provided by the engine per run.
      const runId = yield* activity('who-am-i', Run.use((run) => Effect.succeed(run.runId)), Schema.String);
      yield* activity('log', RunLog.use((log) => log.log(`hello from ${key}`)));
      executed.push(`${key}:${runId}`);

      if (key === 'skip') return yield* new Skip({ reason: 'nothing to do' });

      if (key === 'human') return yield* activity('give-up', Effect.fail(new NeedsHuman({ reason: 'loop cap' })));

      if (key === 'boom') return yield* activity('explode', Effect.fail(new StepFailed({ step: 'explode', message: 'kaboom' })));

      if (key === 'wait') return `woke by ${yield* awaitSignal(['pushed'], { id: 'round-1', timeout: '1 hour' })}`;

      return `did ${key}`;
    }),
});

const handle = flowHandle(repo, 'demo', flow);

// The flow under test reaches only for its run's own services; the others fail loudly if it touches them.
const repoServices = Layer.mergeAll(
  Layer.succeed(Repo, settings),
  Layer.mock(GitHub)({}),
  Layer.mock(Git)({}),
  Layer.mock(Worktree)({ pathFor: (branch) => `/tmp/demo-worktrees/${branch}` }),
  Layer.mock(Usage)({}),
  Layer.mock(Agent)({ adapters: [] }),
  Layer.mock(StepRunner)({}),
);

// A fresh home and engine for each test, with the platform the test runs on.
const withEngine = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-engine-' });
    const homeLayer = Home.at(home, home);
    const engine = yield* Layer.build(flowLayer(handle, repoServices).pipe(Layer.provideMerge(StateAt(homePaths(home).state)), Layer.provideMerge(homeLayer)));
    const platform = yield* Effect.context<BunServices.BunServices>();

    return { home, value: yield* Effect.provideContext(program, Context.merge(platform, engine)) };
  });

const POLLS = 200;

const isRunning = (run: RunRow) => run.status === 'running';

// Polls the run until its workflow finishes.
const toEnd = (run: RunRow) =>
  pollRun(handle, run).pipe(
    Effect.repeat({ schedule: Schedule.spaced('25 millis'), while: isRunning, times: POLLS }),
    Effect.filterOrElse(
      (polled) => !isRunning(polled),
      () => Effect.die(`run ${run.id} never finished`),
    ),
  );

const started = (work: WorkItem) => startRun(handle, work).pipe(Effect.flatMap((outcome) => Effect.fromOption(outcome.run)), Effect.orDie);

const runToEnd = (work: WorkItem) => started(work).pipe(Effect.flatMap(toEnd));

const summaryOf = (run: RunRow) => Option.getOrElse(run.summary, () => '');

describe('the engine', () => {
  effect(
    'runs a flow to done, giving each activity the run it belongs to',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, value: finished } = yield* withEngine(runToEnd(item('one')));
      expect(finished.status).toBe('done');
      expect(summaryOf(finished)).toBe('did one');
      expect(executed).toContain(`one:${finished.id}`);
      const log = yield* fs.readFileString(homePaths(home).runLog(finished.id));
      expect(log).toContain('hello from one');
      expect(log).toContain('step: who-am-i');
    }),
  );

  effect(
    'a Skip ends the run cleanly, and NeedsHuman hands it to a person',
    () => Effect.gen(function* () {
      const { value } = yield* withEngine(Effect.all({ skipped: runToEnd(item('skip')), human: runToEnd(item('human')) }));
      expect(value.skipped.status).toBe('skipped');
      expect(value.human.status).toBe('needs-human');
      expect(summaryOf(value.human)).toBe('loop cap');
    }),
  );

  effect(
    'any other failure fails the run and names the activity',
    () => Effect.gen(function* () {
      const { value: failed } = yield* withEngine(runToEnd(item('boom')));
      expect(failed.status).toBe('failed');
      expect(summaryOf(failed)).toContain('explode');
      expect(summaryOf(failed)).toContain('kaboom');
    }),
  );

  effect(
    'an item with a run in flight does not get a second one',
    () => Effect.gen(function* () {
      const { value } = yield* withEngine(Effect.all({ first: startRun(handle, item('wait')), second: startRun(handle, item('wait')) }));
      expect(value.first.started).toBe(true);
      expect(value.second.started).toBe(false);
      expect(Option.map(value.second.run, (run) => run.id)).toEqual(Option.map(value.first.run, (run) => run.id));
    }),
  );

  effect(
    'a waiting run wakes when the trigger reports its signal',
    () => Effect.gen(function* () {
      const wakes = Effect.gen(function* () {
        const state = yield* State;
        const run = yield* started(item('wait'));

        // Before the run registers its wait, there is nothing to deliver.
        yield* state.waitsFor(run.id, 'pushed').pipe(Effect.repeat({ schedule: Schedule.spaced('25 millis'), until: (waits) => waits.length > 0, times: POLLS }));
        expect(yield* deliverSignals(handle, [item('wait', ['pushed'])])).toBe(1);

        return yield* toEnd(run);
      });

      const { value: finished } = yield* withEngine(wakes);
      expect(finished.status).toBe('done');
      expect(summaryOf(finished)).toBe('woke by pushed');
    }),
  );
});
