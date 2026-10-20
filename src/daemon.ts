// One long-running daemon per machine schedules every enrolled repo's flows,
// records state in SQLite, and serves the CLI and TUI over a local socket. It
// is the only process that runs the workflow engine.

import { describeError, type FlowFailure, type WorkItem } from '@chernabog/sdk';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as Arr from 'effect/Array';
import * as DateTime from 'effect/DateTime';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Equivalence from 'effect/Equivalence';
import * as FileSystem from 'effect/FileSystem';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Ref from 'effect/Ref';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

import { Home, homePaths } from './config.ts';
import { deliverSignals, type FlowHandle, flowHandle, flowLayer, pollRun, startRun, StateLive } from './engine.ts';
import { viewerLogin } from './GitHubApi.ts';
import { describeLauncher } from './launchers.ts';
import { loadFlows } from './loader.ts';
import { acquireLock } from './lock.ts';
import { DaemonStatus, Refusal, Reloaded, type RepoStatus, RunReply, RunRequest, TickResult } from './protocol.ts';
import { type EffectiveRepo, type EnrolledRepo, flowOff, loadMachineConfig, loadRepo, type MachineConfig, needsLogin, repoNameOf, type Routing, routingOf } from './repo-config.ts';
import { runLogWriting } from './runlog.ts';
import { buildRepoContext, type RepoContext, withRepo } from './runner.ts';
import { decideTick, describeElsewhere, freeSlots, nextTick, routeItems, scheduleFor } from './schedule.ts';
import { configTree, snapshotConfig } from './snapshot.ts';
import { State } from './state.ts';
import { trustedTree } from './trust.ts';

// Exits with this when the config changed, so launchd or systemd starts it again on the new config.
export const RELOAD_EXIT_CODE = 75;

const PausedFile = Schema.fromJsonString(Schema.Array(Schema.String));

const pausedFile = Home.use((home) => Effect.succeed(homePaths(home.root).paused));

export const readPaused = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* pausedFile;

  if (!(yield* fs.exists(path))) return [];

  return Option.getOrElse(Schema.decodeOption(PausedFile)(yield* fs.readFileString(path)), () => []);
}).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

export const setPaused = (name: string, paused: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const others = (yield* readPaused).filter((known) => known !== name);
    const names = Arr.sort(Arr.appendAll(others, Option.toArray(Option.liftPredicate(name, () => paused))), Order.String);
    yield* fs.writeFileString(yield* pausedFile, `${yield* Schema.encodeEffect(PausedFile)(names)}\n`);
  });

type FlowSchedule = {
  readonly handle: FlowHandle;
  readonly expression: string;
  next: Option.Option<DateTime.Utc>;
  lastTick: Option.Option<DateTime.Utc>;
  queued: ReadonlyArray<string>;
  // What the last tick left for other machines, by flows.<flow>.assignee and reviewRequested.
  elsewhere: ReadonlyArray<string>;
};

export type RepoState = {
  readonly enrolled: EnrolledRepo;
  readonly name: string;
  readonly status: RepoStatus['status'];
  readonly message: Option.Option<string>;
  readonly tree: Option.Option<string>;
  readonly repo: Option.Option<EffectiveRepo>;
  readonly flows: ReadonlyArray<FlowSchedule>;
  latestTree: Option.Option<string>;
  // The person's local.yaml as the daemon last saw it; none while absent.
  localConfig: Option.Option<string>;
};

const baseBranchOf = (enrolled: EnrolledRepo) => enrolled.baseBranch ?? 'main';

const readLocalConfig = (enrolled: EnrolledRepo) => FileSystem.FileSystem.use((fs) => fs.readFileString(`${enrolled.path}/.chernabog/local.yaml`)).pipe(Effect.option);

// Snapshots a repo's .chernabog/ from its base branch and loads its flows,
// unless the snapshot is not the tree that was trusted.
export const loadRepoState = (machine: MachineConfig, enrolled: EnrolledRepo, index: number, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const name = repoNameOf(enrolled);
    // Read before loading, so a change made while the repo loads is noticed after.
    const localConfig = yield* readLocalConfig(enrolled);
    const unloaded = { enrolled, name, repo: Option.none(), flows: [], localConfig };

    const failed = (message: string, tree: Option.Option<string>): RepoState => ({ ...unloaded, status: 'error', message: Option.some(message), tree, latestTree: tree });

    const snapshot = yield* Effect.result(snapshotConfig(enrolled.path, baseBranchOf(enrolled)));

    if (Result.isFailure(snapshot)) return failed(describeError(snapshot.failure), Option.none());

    const { configDir, tree } = snapshot.success;
    const trusted = yield* trustedTree(enrolled.repo);

    if (!Option.contains(trusted, tree)) {
      const message = Option.match(trusted, {
        onNone: () => `not trusted yet; run chernabog trust ${name}`,
        onSome: () => `.chernabog/ changed on the base branch; review it with chernabog trust ${name}`,
      });

      return { ...unloaded, status: 'untrusted', message: Option.some(message), tree: Option.some(tree), latestTree: Option.some(tree) } satisfies RepoState;
    }

    const loaded = yield* Effect.result(Effect.all({ repo: loadRepo(machine, enrolled, configDir), flows: loadFlows(configDir) }));

    if (Result.isFailure(loaded)) return failed(describeError(loaded.failure), Option.some(tree));

    const { flows, repo } = loaded.success;

    return {
      enrolled,
      name,
      status: 'ready',
      message: Option.none(),
      tree: Option.some(tree),
      repo: Option.some(repo),
      flows: [...flows].map(([flowName, flow]): FlowSchedule => {
        const expression = scheduleFor(repo, flowName, flow, index, machine.repos.length);

        return { handle: flowHandle(repo, flowName, flow), expression, next: nextTick(expression, now), lastTick: Option.none(), queued: [], elsewhere: [] };
      }),
      latestTree: Option.some(tree),
      localConfig,
    } satisfies RepoState;
  });

export type TickOptions = { readonly gates: boolean; readonly item: Option.Option<string> };

const describeQueued = (item: WorkItem) => Option.match(Option.fromUndefinedOr(item.title), { onNone: () => item.key, onSome: (title) => `${item.key} ${title}` });

// The items a run may start for: not only waking one, and without a run already.
const unstarted = (handle: FlowHandle, items: ReadonlyArray<WorkItem>) =>
  Effect.gen(function* () {
    const state = yield* State;
    const waiting: Array<WorkItem> = [];

    for (const item of items) {
      if (item.wakeOnly !== true && Option.isNone(yield* state.activeRunFor(handle.repo.settings.name, handle.name, item.key))) waiting.push(item);
    }

    return waiting;
  });

type Routed = ReturnType<typeof routeItems>;

// What a tick may start: the items this machine may start, or the one a
// person named, whoever it is assigned to.
const candidatesOf = (waiting: ReadonlyArray<WorkItem>, routed: Routed, named: Option.Option<string>) =>
  Option.match(named, { onNone: () => routed.mine, onSome: (key) => waiting.filter((item) => item.key === key) });

// Why a tick starts nothing although its trigger found work: all of it is for others.
const onlyElsewhere = (routed: Routed, routing: Routing, named: Option.Option<string>) =>
  Option.liftPredicate(`only work for others: ${routed.elsewhere.map(describeElsewhere(routing)).join(', ')}`, () => Option.isNone(named) && routed.mine.length === 0 && routed.elsewhere.length > 0);

// The gate's Skip is its own reason; anything else is the gate failing.
const gateReason = (failure: FlowFailure) => {
  if (Predicate.isTagged(failure, 'Skip') && Predicate.hasProperty(failure, 'reason')) return String(failure.reason);

  return `gate failed: ${describeError(failure)}`;
};

const formatOption = (at: Option.Option<DateTime.Utc>) => Option.map(at, DateTime.formatIso);

const sameTree = Option.makeEquivalence(Equivalence.String);
const sameText = Option.makeEquivalence(Equivalence.String);

const changedAction = (trusted: boolean) => {
  if (trusted) return 'trusted, restarting on it when idle';

  return 'not trusted, starting no new runs until chernabog trust';
};

const SOONEST_MS = 200;
const LATEST_MS = 15_000;

const PathParams = Schema.Struct({ id: Schema.String });

export const runDaemon = Effect.gen(function* () {
  const paths = homePaths((yield* Home).root);
  const fs = yield* FileSystem.FileSystem;
  yield* acquireLock(paths.engineLock, 'daemon');
  const daemonLog = yield* runLogWriting(paths.daemonLog);
  const log = daemonLog.log;
  const machine = yield* loadMachineConfig;
  const startedAt = yield* DateTime.now;
  const repos = yield* Effect.forEach(machine.repos, (enrolled, index) => loadRepoState(machine, enrolled, index, startedAt));

  for (const repo of repos) {
    const message = Option.match(repo.message, { onNone: () => '', onSome: (said) => `: ${said}` });
    const flows = Option.match(Option.liftPredicate(repo.flows, Arr.isReadonlyArrayNonEmpty), { onNone: () => '', onSome: (found) => ` (flows: ${found.map((flow) => flow.handle.name).join(', ')})` });
    yield* log(`${repo.name}: ${repo.status}${message}${flows}`);
  }

  // Who this machine is on GitHub, for repos that name their flows' runners
  // or start only work assigned to it.
  let login = Option.none<string>();

  if (repos.some((repo) => Option.exists(repo.repo, needsLogin))) {
    const found = yield* Effect.result(viewerLogin);
    login = Result.getSuccess(found);
    yield* log(Result.match(found, { onSuccess: (self) => `this machine is ${self} on GitHub`, onFailure: (error) => `could not tell who this machine is on GitHub: ${error.message}` }));
  }

  const busy = yield* Ref.make(0);
  const hooks = { onStep: () => Ref.update(busy, (count) => count + 1), onStepDone: () => Ref.update(busy, (count) => count - 1) };

  const contexts = new Map<string, RepoContext>();

  for (const repo of repos) {
    if (Option.isSome(repo.repo)) contexts.set(repo.name, yield* buildRepoContext(repo.repo.value, machine));
  }

  const handles = repos.flatMap((repo) => repo.flows.map((flow) => flow.handle));

  const flowLayers = handles.flatMap((handle) =>
    Option.toArray(Option.map(Option.fromUndefinedOr(contexts.get(handle.repo.settings.name)), (context) => flowLayer(handle, Layer.succeedContext(context), hooks))),
  );

  const engine = yield* Layer.build(Layer.mergeAll(Layer.empty, ...flowLayers).pipe(Layer.provideMerge(StateLive)));

  return yield* Effect.provideContext(
    Effect.gen(function* () {
      const state = yield* State;
      const reloadPending = yield* Ref.make(false);
      const reloaded = yield* Deferred.make<true>();

      const handleFor = (repoName: string, flowName: string) => Arr.findFirst(handles, (handle) => handle.repo.settings.name === repoName && handle.name === flowName);

      const parked = Effect.all({ active: state.activeRuns({ repo: Option.none(), flow: Option.none() }), parkedIds: state.parkedRunIds });

      const tick = (repo: RepoState, settings: EffectiveRepo, context: RepoContext, schedule: FlowSchedule, options: TickOptions) =>
        Effect.gen(function* () {
          const { handle } = schedule;
          const { flow } = handle;
          const flowSettings = Record.get(settings.flows, handle.name);

          const record = (reason: string, itemKey: Option.Option<string>) =>
            state.recordSkip({ repo: repo.name, flow: handle.name, itemKey, reason }).pipe(Effect.as({ started: [], skipped: Option.some(reason) } satisfies TickResult));

          if (options.gates) {
            const decision = decideTick({
              enabled: settings.enabled,
              flowOff: flowOff(settings, handle.name, login),
              paused: (yield* readPaused).includes(repo.name),
              quietHours: machine.quietHours,
              activeHours: settings.activeHours,
              now: yield* DateTime.now,
            });

            if (!decision.go) return yield* record(decision.reason, Option.none());
          }

          const triggered = yield* Effect.result(withRepo(context, flow.trigger));

          if (Result.isFailure(triggered)) return yield* record(`trigger failed: ${describeError(triggered.failure)}`, Option.none());

          const items = triggered.success;
          yield* deliverSignals(handle, items);
          const waiting = yield* unstarted(handle, items);
          // Work for others is left to their machines, unless a person names the item.
          const routing = routingOf(settings, handle.name);
          const routed = routeItems(waiting, routing, login);
          schedule.lastTick = Option.some(yield* DateTime.now);
          schedule.queued = routed.mine.map(describeQueued);
          schedule.elsewhere = routed.elsewhere.map(describeElsewhere(routing));

          const candidates = candidatesOf(waiting, routed, options.item);
          const elsewhereOnly = onlyElsewhere(routed, routing, options.item);

          if (Option.isSome(elsewhereOnly)) return yield* record(elsewhereOnly.value, Option.none());

          if (candidates.length === 0) return { started: [], skipped: Option.none() } satisfies TickResult;

          let slots = candidates.length;

          if (options.gates) {
            const { active, parkedIds } = yield* parked;
            const working = active.filter((activeRun) => !parkedIds.includes(activeRun.id));

            slots = freeSlots({
              activeForFlow: working.filter((activeRun) => activeRun.repo === repo.name && activeRun.flow === handle.name).length,
              flowConcurrency: Option.getOrElse(Option.flatMap(flowSettings, (found) => Option.fromUndefinedOr(found.concurrency)), () => flow.concurrency ?? 1),
              activeOnMachine: working.length,
              machineConcurrency: machine.concurrency,
            });

            if (slots === 0) return yield* record(`at the concurrency limit; waiting: ${candidates.map((item) => item.key).join(', ')}`, Option.none());
          }

          const started: Array<string> = [];
          const gate = Option.fromUndefinedOr(flow.gate).pipe(Option.filter(() => options.gates));

          for (const item of candidates.slice(0, slots)) {
            if (Option.isSome(gate)) {
              const passed = yield* Effect.result(withRepo(context, gate.value));

              // The gate holds back every item this tick, not only this one.
              if (Result.isFailure(passed)) {
                const reason = gateReason(passed.failure);
                yield* record(reason, Option.some(item.key));

                return { started, skipped: Option.some(reason) } satisfies TickResult;
              }
            }

            const outcome = yield* startRun(handle, item);

            if (outcome.started && Option.isSome(outcome.run)) {
              started.push(outcome.run.value.id);
              yield* log(`started ${outcome.run.value.id}`);
            }
          }

          return { started, skipped: Option.none() } satisfies TickResult;
        }).pipe(
          Effect.catchCause((cause) =>
            log(`${repo.name}/${schedule.handle.name}: tick failed: ${String(cause)}`).pipe(Effect.as({ started: [], skipped: Option.some('tick failed') } satisfies TickResult)),
          ),
        );

      // A repo whose flows may run: loaded, and its base branch still on the trusted tree.
      const runnable = (repo: RepoState) =>
        Option.filter(repo.repo, () => repo.status === 'ready' && sameTree(repo.latestTree, repo.tree)).pipe(
          Option.flatMap((settings) => Option.map(Option.fromUndefinedOr(contexts.get(repo.name)), (context) => ({ settings, context }))),
        );

      // Polls running workflows and records the ones that finished.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            for (const activeRun of yield* state.activeRuns({ repo: Option.none(), flow: Option.none() })) {
              const handle = handleFor(activeRun.repo, activeRun.flow);

              if (Option.isNone(handle)) continue;

              const polled = yield* pollRun(handle.value, activeRun);

              if (polled.status !== 'running') yield* log(`finished ${polled.id}: ${polled.status}: ${Option.getOrElse(polled.summary, () => '')}`);
            }

            yield* Effect.sleep('3 seconds');
          }),
        ),
      );

      // Runs each flow's trigger when its schedule comes due.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const now = yield* DateTime.now;

            for (const repo of repos) {
              const ready = runnable(repo);

              if (Option.isNone(ready)) continue;

              for (const schedule of repo.flows) {
                if (!Option.exists(schedule.next, (next) => DateTime.isLessThanOrEqualTo(next, now))) continue;

                schedule.next = nextTick(schedule.expression, now);
                const result = yield* tick(repo, ready.value.settings, ready.value.context, schedule, { gates: true, item: Option.none() });

                if (Option.isSome(result.skipped)) yield* log(`${repo.name}/${schedule.handle.name}: skipped: ${result.skipped.value}`);
              }
            }

            const dueIn = repos.flatMap((repo) => repo.flows.flatMap((flow) => Option.toArray(flow.next))).map((next) => DateTime.toEpochMillis(next) - DateTime.toEpochMillis(now));
            yield* Effect.sleep(Math.max(SOONEST_MS, Math.min(LATEST_MS, ...dueIn)));
          }),
        ),
      );

      // Notices a new .chernabog/ on a base branch: trusted, it restarts the
      // daemon on it once nothing is executing; untrusted, the repo starts no new runs.
      const checkConfig = Effect.gen(function* () {
        for (const repo of repos) {
          const tree = yield* Effect.result(configTree(repo.enrolled.path, baseBranchOf(repo.enrolled)));

          if (Result.isFailure(tree) || Option.contains(repo.latestTree, tree.success)) continue;

          repo.latestTree = Option.some(tree.success);
          const trusted = Option.contains(yield* trustedTree(repo.enrolled.repo), tree.success);
          yield* log(`${repo.name}: .chernabog/ changed (${tree.success.slice(0, 8)}); ${changedAction(trusted)}`);

          if (trusted) yield* Ref.set(reloadPending, true);
        }

        for (const repo of repos) {
          const trusted = yield* trustedTree(repo.enrolled.repo);

          if (repo.status !== 'ready' && Option.isSome(repo.latestTree) && sameTree(trusted, repo.latestTree)) yield* Ref.set(reloadPending, true);
        }
      });

      // Notices an edit to a person's local.yaml, such as a flow turned off
      // in the live view, and restarts the daemon on it once nothing is executing.
      const checkLocalConfig = Effect.gen(function* () {
        for (const repo of repos) {
          const current = yield* readLocalConfig(repo.enrolled);

          if (sameText(current, repo.localConfig)) continue;

          repo.localConfig = current;
          yield* log(`${repo.name}: local.yaml changed; restarting on it when idle`);
          yield* Ref.set(reloadPending, true);
        }
      });

      yield* Effect.forkScoped(Effect.forever(Effect.sleep('5 minutes').pipe(Effect.andThen(checkConfig))));
      yield* Effect.forkScoped(Effect.forever(Effect.sleep('10 seconds').pipe(Effect.andThen(checkLocalConfig))));

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep('2 seconds');

            if ((yield* Ref.get(reloadPending)) && (yield* Ref.get(busy)) === 0) yield* Deferred.succeed(reloaded, true);
          }),
        ),
      );

      const repoStatus = (paused: ReadonlyArray<string>) => (repo: RepoState) => {
        const stale = repo.status === 'ready' && !sameTree(repo.latestTree, repo.tree);
        const offReason = (name: string) => Option.flatMap(repo.repo, (settings) => flowOff(settings, name, login));

        const status: RepoStatus = {
          name: repo.name,
          slug: repo.enrolled.repo,
          status: repo.status,
          message: repo.message,
          paused: paused.includes(repo.name),
          enabled: Option.match(repo.repo, { onNone: () => true, onSome: (settings) => settings.enabled }),
          tree: repo.tree,
          launcher: Option.map(repo.repo, (loaded) => describeLauncher(loaded.settings)),
          flows: repo.flows.map((flow) => ({
            name: flow.handle.name,
            schedule: flow.expression,
            next: formatOption(flow.next),
            lastTick: formatOption(flow.lastTick),
            queued: flow.queued,
            assignedElsewhere: flow.elsewhere,
            enabled: Option.isNone(offReason(flow.handle.name)),
            ...Option.match(offReason(flow.handle.name), { onNone: () => ({}), onSome: (reason) => ({ offReason: reason }) }),
          })),
        };

        if (!stale) return status;

        return { ...status, status: 'untrusted', message: Option.some(`.chernabog/ changed on the base branch; review it with chernabog trust ${repo.name}`) } satisfies RepoStatus;
      };

      const status = Effect.gen(function* () {
        const { active, parkedIds } = yield* parked;

        return {
          pid: process.pid,
          startedAt: DateTime.formatIso(startedAt),
          busy: yield* Ref.get(busy),
          reloadPending: yield* Ref.get(reloadPending),
          repos: repos.map(repoStatus(yield* readPaused)),
          active: active.map((activeRun) => ({ ...activeRun, parked: parkedIds.includes(activeRun.id) })),
          recent: yield* state.recentRuns(20),
          skips: yield* state.recentSkips(20),
        } satisfies DaemonStatus;
      });

      const findSchedule = (repoName: string, flowName: string) => {
        const repo = Arr.findFirst(repos, (candidate) => candidate.name === repoName || candidate.enrolled.repo === repoName);

        if (Option.isNone(repo)) return Result.fail(`no enrolled repo named ${repoName}`);

        const ready = runnable(repo.value);

        if (Option.isNone(ready)) return Result.fail(`${repo.value.name} is ${repo.value.status}: ${Option.getOrElse(repo.value.message, () => 'not ready')}`);

        const schedule = Arr.findFirst(repo.value.flows, (flow) => flow.handle.name === flowName);

        if (Option.isNone(schedule)) {
          return Result.fail(`${repo.value.name} has no flow named ${flowName} (flows: ${repo.value.flows.map((flow) => flow.handle.name).join(', ')})`);
        }

        return Result.succeed({ repo: repo.value, ...ready.value, schedule: schedule.value });
      };

      const refuse = (code: number, error: string) => HttpServerResponse.schemaJson(Refusal)({ error }, { status: code });

      const answer = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => handler.pipe(Effect.catch((error) => refuse(500, describeError(error))));

      const runOrTick = (gates: boolean) =>
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(RunRequest);
          const found = findSchedule(body.repo, body.flow);

          if (Result.isFailure(found)) return yield* refuse(404, found.failure);

          const { context, repo, schedule, settings } = found.success;

          return yield* HttpServerResponse.schemaJson(TickResult)(yield* tick(repo, settings, context, schedule, { gates, item: body.item }));
        });

      const routes = Layer.mergeAll(
        HttpRouter.add('GET', '/status', answer(status.pipe(Effect.flatMap(HttpServerResponse.schemaJson(DaemonStatus))))),
        HttpRouter.add(
          'GET',
          '/runs/:id',
          answer(
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.schemaPathParams(PathParams);

              return yield* HttpServerResponse.schemaJson(RunReply)(yield* state.run(id));
            }),
          ),
        ),
        HttpRouter.add('POST', '/reload', answer(checkConfig.pipe(Effect.andThen(checkLocalConfig), Effect.andThen(Ref.get(reloadPending)), Effect.flatMap((pending) => HttpServerResponse.schemaJson(Reloaded)({ reloadPending: pending }))))),
        HttpRouter.add('POST', '/run', answer(runOrTick(false))),
        HttpRouter.add('POST', '/tick', answer(runOrTick(true))),
      );

      yield* fs.remove(paths.socket, { force: true });
      yield* Effect.addFinalizer(() => fs.remove(paths.socket, { force: true }).pipe(Effect.ignore));
      yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(BunHttpServer.layer({ unix: paths.socket }))));
      yield* log(`daemon ${process.pid} listening on ${paths.socket}`);

      yield* Deferred.await(reloaded);
      yield* log('restarting on new config');

      return RELOAD_EXIT_CODE;
    }),
    engine,
  );
}).pipe(Effect.scoped);
