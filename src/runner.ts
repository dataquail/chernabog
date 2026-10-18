// Opens an enrolled repo (its config layers and flows) and runs one flow in
// the foreground: `chernabog run <flow> --repo <name>`.

import { type Flow, RunLog } from '@chernabog/sdk';
import * as Arr from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Console from 'effect/Console';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';

import { ConfigError, Home, homePaths } from './config.ts';
import { deliverSignals, type FlowHandle, flowHandle, flowLayer, pollRun, repoServices, runLogFile, startRun, StateLive } from './engine.ts';
import { loadFlows } from './loader.ts';
import { acquireLock } from './lock.ts';
import { type EffectiveRepo, type EnrolledRepo, findEnrolled, loadMachineConfig, loadRepo, type MachineConfig } from './repo-config.ts';
import { snapshotConfig } from './snapshot.ts';
import { type RunRow, State } from './state.ts';

export type OpenRepo = { readonly repo: EffectiveRepo; readonly flows: ReadonlyMap<string, Flow>; readonly tree: Option.Option<string> };

// The trusted .chernabog/ comes from the base branch; `fromCheckout` reads the
// working copy instead, for trying out a change before merging it.
export const repoConfigDir = (enrolled: EnrolledRepo, fromCheckout: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let tree = Option.none<string>();
    let configDir = `${enrolled.path}/.chernabog`;

    if (!fromCheckout) {
      const snapshot = yield* snapshotConfig(enrolled.path, enrolled.baseBranch ?? 'main');
      tree = Option.some(snapshot.tree);
      configDir = snapshot.configDir;
    }

    if (!(yield* fs.exists(configDir))) return yield* new ConfigError({ message: `${enrolled.path}: no .chernabog/; run chernabog init` });

    return { tree, configDir };
  });

export const openRepo = (machine: MachineConfig, enrolled: EnrolledRepo, fromCheckout: boolean) =>
  Effect.gen(function* () {
    const { configDir, tree } = yield* repoConfigDir(enrolled, fromCheckout);
    const repo = yield* loadRepo(machine, enrolled, configDir);
    const flows = yield* loadFlows(configDir);

    return { repo, flows, tree } satisfies OpenRepo;
  });

// What a trigger, gate or step logs outside any run goes to stderr.
const consoleRunLog = RunLog.of({ log: (line) => Console.error(line), step: () => Effect.void, stepDone: () => Effect.void });

// One repo's services, built once at its composition point and shared by
// every trigger, gate and run of its flows.
export const buildRepoContext = (repo: EffectiveRepo, machine: MachineConfig) =>
  Effect.gen(function* () {
    const platform = yield* Effect.context<FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>();
    const services = yield* Layer.build(Layer.mergeAll(repoServices(repo.settings, machine.usageGate, machine.agents), Layer.succeed(RunLog, consoleRunLog)));

    return Context.merge(platform, services);
  });

export type RepoContext = Effect.Success<ReturnType<typeof buildRepoContext>>;

// Runs a flow's trigger (or gate) with the repo's services.
export const withRepo = <A, E, R>(context: Context.Context<R>, effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);

// Prints what a log file gains, from where it was last read.
export const tailer = (path: string) => {
  let offset = 0;

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(path))) return;

    const text = yield* fs.readFileString(path);

    if (text.length <= offset) return;

    const fresh = text.slice(offset);
    offset = text.length;
    yield* Console.log(fresh.trimEnd());
  }).pipe(Effect.ignore);
};

const SIGNAL_EVERY_MS = 60_000;

const followRun = (handle: FlowHandle, run: RunRow, context: RepoContext) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(run.id));
    let current = run;
    let lastSignalCheck = yield* Clock.currentTimeMillis;

    while (current.status === 'running') {
      yield* tail;
      yield* Effect.sleep('1 second');
      current = yield* pollRun(handle, current);
      const now = yield* Clock.currentTimeMillis;

      if (now - lastSignalCheck > SIGNAL_EVERY_MS) {
        lastSignalCheck = now;
        const items = yield* withRepo(context, handle.flow.trigger).pipe(Effect.orElseSucceed(() => []));
        yield* deliverSignals(handle, items);
      }
    }

    yield* tail;

    return current;
  });

export type RunOptions = { readonly repo: string; readonly flow: string; readonly item: Option.Option<string>; readonly fromCheckout: boolean };

const describeItem = (item: { readonly key: string; readonly title?: string }) => Option.match(Option.fromUndefinedOr(item.title), { onNone: () => item.key, onSome: (title) => `${item.key} (${title})` });

const resume = (handle: FlowHandle, unfinished: RunRow, context: RepoContext) =>
  Effect.gen(function* () {
    yield* Console.log(`resuming ${unfinished.id} (${unfinished.itemKey}), log: ${yield* runLogFile(unfinished.id)}`);

    if (Option.isSome(unfinished.executionId)) yield* handle.workflow.resume(unfinished.executionId.value);

    return Option.some(yield* followRun(handle, unfinished, context));
  });

const startFirst = (handle: FlowHandle, options: RunOptions, context: RepoContext) =>
  Effect.gen(function* () {
    const items = (yield* withRepo(context, handle.flow.trigger)).filter((candidate) => candidate.wakeOnly !== true);

    const found = Option.match(options.item, {
      onNone: () => Option.fromUndefinedOr(items[0]),
      onSome: (key) => Option.fromUndefinedOr(items.find((candidate) => candidate.key === key)),
    });

    if (Option.isNone(found)) {
      yield* Console.log(Option.match(options.item, { onNone: () => 'nothing to do: the trigger found no work', onSome: (key) => `the trigger found no item ${key}` }));

      return Option.none<RunRow>();
    }

    const { run } = yield* startRun(handle, found.value);

    if (Option.isNone(run)) return Option.none<RunRow>();

    yield* Console.log(`started ${run.value.id} for ${describeItem(found.value)}, log: ${yield* runLogFile(run.value.id)}`);

    return Option.some(yield* followRun(handle, run.value, context));
  });

// One run now, skipping gates: resumes the flow's unfinished run in this repo
// if there is one, otherwise starts one for the given item or the first the
// trigger finds.
export const runInForeground = (options: RunOptions) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;
    const enrolled = yield* findEnrolled(machine, options.repo);
    const { flows, repo } = yield* openRepo(machine, enrolled, options.fromCheckout);
    const flow = Option.fromUndefinedOr(flows.get(options.flow));

    if (Option.isNone(flow)) {
      const known = Option.getOrElse(Option.liftPredicate([...flows.keys()].join(', '), (names) => names.length > 0), () => 'none');

      return yield* new ConfigError({ message: `${repo.settings.name} has no flow named ${options.flow} (flows: ${known})` });
    }

    const handle = flowHandle(repo, options.flow, flow.value);
    yield* acquireLock(homePaths((yield* Home).root).engineLock, `run ${options.flow} --repo ${repo.settings.name}`);
    const context = yield* buildRepoContext(repo, machine);

    const program = Effect.gen(function* () {
      const state = yield* State;
      const unfinished = Arr.head(yield* state.activeRuns({ repo: Option.some(repo.settings.name), flow: Option.some(options.flow) }));

      if (Option.isSome(unfinished)) return yield* resume(handle, unfinished.value, context);

      return yield* startFirst(handle, options, context);
    });

    const engine = yield* Layer.build(flowLayer(handle, Layer.succeedContext(context)).pipe(Layer.provideMerge(StateLive)));

    return yield* Effect.provideContext(program, engine);
  }).pipe(Effect.scoped);
