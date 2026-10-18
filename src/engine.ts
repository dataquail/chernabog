// Runs flows durably. Each repo's flow is an Effect workflow, journaled in
// SQLite; each work item gets its own execution, keyed by run, so one item
// never has two runs at once and a finished item can run again later. The
// engine must live in exactly one process: a second process on the same
// database takes over workflows the first is still running.

import { describeError, type Flow, NeedsHuman, type RepoSettings, Run, RunLog, signalDeferred, Signals, Skip, WorkItem } from '@chernabog/sdk';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import * as Cause from 'effect/Cause';
import * as ClusterWorkflowEngine from 'effect/cluster/ClusterWorkflowEngine';
import * as SingleRunner from 'effect/cluster/SingleRunner';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as DurableDeferred from 'effect/workflow/DurableDeferred';
import * as Workflow from 'effect/workflow/Workflow';

import { adaptersFor, AgentLive, type AgentsConfig } from './agents.ts';
import { Home, homePaths } from './config.ts';
import { GitHubApi } from './GitHubApi.ts';
import type { EffectiveRepo } from './repo-config.ts';
import { noHooks, runLogWriting, type StepHooks } from './runlog.ts';
import { GitHubLive, GitLive, RepoLive, UsageLive, WorktreeLive } from './sdk-live.ts';
import { type RunRow, type RunStatus, State } from './state.ts';
import { StepRunnerLive } from './steps.ts';
import type { GateConfig } from './usage-gate.ts';

export const RunResult = Schema.Struct({
  status: Schema.Literals(['done', 'skipped', 'needs-human']),
  summary: Schema.String,
});

export type RunResult = typeof RunResult.Type;

export class RunFailed extends Schema.TaggedError<RunFailed, { readonly brand: 'RunFailed' }>()('RunFailed', {
  message: Schema.String,
}) {}

// The workflow engine and its SQLite journal, in `database`.
export const EngineAt = (database: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(database.slice(0, database.lastIndexOf('/')), { recursive: true });

      return ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(SingleRunner.layer({ runnerStorage: 'memory' })), Layer.provideMerge(SqliteClient.layer({ filename: database })));
    }).pipe(Effect.orDie),
  );

export const StateAt = (database: string) => State.layer.pipe(Layer.provideMerge(EngineAt(database)));

// The engine and state in this machine's state.db.
export const StateLive = Layer.unwrap(Home.use((home) => Effect.succeed(StateAt(homePaths(home.root).state))));

// The services every flow, trigger and step of one repo uses.
export const repoServices = (settings: RepoSettings, gate: GateConfig, agents: AgentsConfig) =>
  Layer.mergeAll(
    RepoLive(settings),
    GitHubLive(settings).pipe(Layer.provide(GitHubApi.layer)),
    GitLive,
    WorktreeLive(settings),
    UsageLive(settings, gate),
    AgentLive(settings, adaptersFor(agents)),
    StepRunnerLive(settings, gate, agents),
  );

const FlowPayload = Schema.Struct({ runId: Schema.String, item: WorkItem });

export type FlowHandle = {
  readonly repo: EffectiveRepo;
  readonly name: string;
  readonly flow: Flow;
  readonly workflow: Workflow.Workflow<string, typeof FlowPayload, typeof RunResult, typeof RunFailed>;
};

export const workflowName = (repo: string, flow: string) => `${repo}/${flow}`;

export const flowHandle = (repo: EffectiveRepo, name: string, flow: Flow): FlowHandle => ({
  repo,
  name,
  flow,
  workflow: Workflow.make(workflowName(repo.settings.name, name), {
    payload: FlowPayload,
    idempotencyKey: (payload) => payload.runId,
    success: RunResult,
    error: RunFailed,
  }),
});

export const runLogFile = (runId: string) => Home.use((home) => Effect.succeed(homePaths(home.root).runLog(runId)));

// A run log for `runId`, from outside its workflow.
export const runLogFor = (runId: string, hooks: StepHooks = noHooks) => runLogFile(runId).pipe(Effect.flatMap((path) => runLogWriting(path, hooks)));

const summaryOf = (summary: string | void) => {
  if (Predicate.isString(summary)) return summary;

  return 'done';
};

// How the workflow ended: Skip and NeedsHuman are outcomes, anything else a failure.
const outcomeOf = <E>(error: E) => {
  if (Schema.is(Skip)(error)) return Effect.succeed<RunResult>({ status: 'skipped', summary: error.reason });

  if (Schema.is(NeedsHuman)(error)) return Effect.succeed<RunResult>({ status: 'needs-human', summary: error.reason });

  return Effect.fail(new RunFailed({ message: describeError(error) }));
};

// Registers a flow's workflow with the engine. The services each run uses
// (repoServices, or fakes in tests) are built once per repo, then given the
// run's own Run and RunLog.
export const flowLayer = <ROut, RIn>(handle: FlowHandle, services: Layer.Layer<ROut, never, RIn>, hooks: StepHooks = noHooks) =>
  handle.workflow
    .toLayer((payload, executionId) =>
      Effect.gen(function* () {
        const state = yield* State;

        const runLog = yield* runLogFor(payload.runId, {
          onStep: (step) => state.setStep(payload.runId, step).pipe(Effect.andThen(hooks.onStep(step))),
          onStepDone: hooks.onStepDone,
        });

        const signals = Signals.of({ register: (signal, deferred, token) => state.addWait({ runId: payload.runId, signal, deferred, token }) });

        const outcome = yield* handle.flow.workflow(payload.item).pipe(
          Effect.map((summary): RunResult => ({ status: 'done', summary: summaryOf(summary) })),
          Effect.catch(outcomeOf),
          Effect.provideService(Run, { flow: handle.name, runId: payload.runId, executionId, item: payload.item }),
          Effect.provideService(RunLog, runLog),
          Effect.provideService(Signals, signals),
        );

        yield* runLog.log(`finished: ${outcome.status}: ${outcome.summary}`);

        return outcome;
      }).pipe(Effect.orDie),
    )
    .pipe(Layer.provide(services));

// 2026-10-17T16:50:44.229Z → 20261017-165044
const timestamp = (now: DateTime.Utc) => DateTime.formatIso(now).replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

export const makeRunId = (repo: string, flow: string, itemKey: string, now: DateTime.Utc) => `${repo}.${flow}.${itemKey.replace(/[^\w-]+/g, '-')}.${timestamp(now)}`;

export type Started = { readonly run: Option.Option<RunRow>; readonly started: boolean };

// Starts one run of a flow for one work item, unless the item already has one.
export const startRun = (handle: FlowHandle, item: WorkItem) =>
  Effect.gen(function* () {
    const state = yield* State;
    const repo = handle.repo.settings.name;
    const active = yield* state.activeRunFor(repo, handle.name, item.key);

    if (Option.isSome(active)) return { run: active, started: false } satisfies Started;

    if (item.wakeOnly === true) return { run: Option.none(), started: false } satisfies Started;

    const runId = makeRunId(repo, handle.name, item.key, yield* DateTime.now);
    yield* state.insertRun({ id: runId, repo, flow: handle.name, itemKey: item.key, itemTitle: Option.fromUndefinedOr(item.title), itemUrl: Option.fromUndefinedOr(item.url) });
    const executionId = yield* handle.workflow.execute({ runId, item }, { discard: true });
    yield* state.setExecution(runId, executionId);

    return { run: yield* state.run(runId), started: true } satisfies Started;
  });

export const statusOfExit = (exit: Exit.Exit<RunResult, RunFailed>): { readonly status: RunStatus; readonly summary: string } => {
  if (Exit.isSuccess(exit)) return exit.value;

  return Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => ({ status: 'failed', summary: Cause.pretty(exit.cause).split('\n')[0] ?? 'failed' }),
    onSome: (failure) => ({ status: 'failed', summary: failure.message }),
  });
};

// Records the run as finished once its workflow completes. Returns the run's row.
export const pollRun = (handle: FlowHandle, run: RunRow) =>
  Effect.gen(function* () {
    const state = yield* State;

    if (run.status !== 'running' || Option.isNone(run.executionId)) return run;

    const result = yield* handle.workflow.poll(run.executionId.value);

    if (Option.isNone(result) || !Predicate.isTagged(result.value, 'Complete')) return run;

    const { status, summary } = statusOfExit(result.value.exit);
    yield* state.finishRun(run.id, status, summary);

    return Option.getOrElse(yield* state.run(run.id), () => run);
  });

const decodeToken = Schema.decodeEffect(DurableDeferred.Token);

// Wakes the runs waiting on a signal the trigger reported for their item.
export const deliverSignals = (handle: FlowHandle, items: ReadonlyArray<WorkItem>) =>
  Effect.gen(function* () {
    const state = yield* State;
    let delivered = 0;

    for (const item of items) {
      const run = yield* state.activeRunFor(handle.repo.settings.name, handle.name, item.key);

      if (Option.isNone(run)) continue;

      for (const signal of item.signals ?? []) {
        for (const wait of yield* state.waitsFor(run.value.id, signal)) {
          yield* DurableDeferred.succeed(signalDeferred(wait.deferred), { token: yield* decodeToken(wait.token), value: true });
          yield* state.removeWait(wait.runId, wait.deferred);
          yield* (yield* runLogFor(wait.runId)).log(`signal: ${signal}`);
          delivered += 1;
        }
      }
    }

    return delivered;
  }).pipe(Effect.orDie);
