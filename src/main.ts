#!/usr/bin/env bun
// The chernabog command line.

import { describeError } from '@chernabog/sdk';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import * as Arr from 'effect/Array';
import * as Cache from 'effect/Cache';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Prompt from 'effect/cli/Prompt';
import * as Console from 'effect/Console';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Result from 'effect/Result';
import * as Schedule from 'effect/Schedule';
import * as Stdio from 'effect/Stdio';

import { attachCommand, runSessions } from './agents.ts';
import { stopHook } from './agents/stop-hook.ts';
import { daemonReload, daemonRun, daemonRunRow, daemonStatus, daemonTick } from './client.ts';
import { Home } from './config.ts';
import { RELOAD_EXIT_CODE, runDaemon, setPaused } from './daemon.ts';
import { doctor, formatCheck } from './doctor.ts';
import { resolveRunId, runLogFile } from './engine.ts';
import { Exec } from './Exec.ts';
import { GitHubTokens } from './github-auth.ts';
import { GitHubApi, viewerLogin } from './GitHubApi.ts';
import { checkFlowNames, chooseFlows, enroll, ensureLocalConfig, flowChoices, repoRoot, scaffold } from './init.ts';
import { desiredLabels, syncLabels, withFlowLabels } from './labels.ts';
import { runLaunch } from './launchers/shim.ts';
import { loadFlows } from './loader.ts';
import { asSuffix, IMPLICIT } from './persona.ts';
import { HostEnvironment } from './platform/environment.ts';
import type { DaemonStatus, TickResult } from './protocol.ts';
import { findEnrolled, FLOW_TURNED_OFF, loadMachineConfig, loadRepo, machineConfigFile, repoNameOf } from './repo-config.ts';
import { repoConfigDir, runInForeground, tailer } from './runner.ts';
import { install, startService, stopService, uninstall } from './service.ts';
import { configTree } from './snapshot.ts';
import { runLabel, type RunRow, shortRunId } from './state.ts';
import { runStepChild, StepServicesLive } from './steps.ts';
import { recordTrust, trustDiff, trustedTree } from './trust.ts';
import { runTui } from './tui/app.ts';
import { VERSION } from './version.ts';

const printLines = (lines: Iterable<string>) => Effect.forEach(lines, (line) => Console.log(line), { discard: true });

const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(message);
    process.exitCode = 1;
  });

const repoFlag = Flag.String('repo').pipe(Flag.withDescription('An enrolled repo, by name or owner/name'));
const repoArgument = Argument.String('repo').pipe(Argument.withDescription('An enrolled repo, by name or owner/name'));
const optionalRepo = Argument.String('repo').pipe(Argument.withDescription('An enrolled repo; all of them when left out'), Argument.optional);

const MINUTE_MS = 60_000;

const relative = (iso: Option.Option<string>, now: DateTime.Utc) =>
  Option.match(Option.flatMap(iso, (text) => DateTime.make(text)), {
    onNone: () => 'never',
    onSome: (at) => {
      const minutes = Math.round((DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)) / MINUTE_MS);

      if (Math.abs(minutes) < 1) return 'now';

      if (minutes > 0) return `in ${minutes}m`;

      return `${-minutes}m ago`;
    },
  });

const suffix = (value: Option.Option<string>, prefix: string) => Option.match(value, { onNone: () => '', onSome: (text) => `${prefix}${text}` });

const when = (condition: boolean, text: string) => Option.getOrElse(Option.liftPredicate(text, () => condition), () => '');

const repoLine = (repo: DaemonStatus['repos'][number]) => {
  if (repo.paused) return 'paused';

  if (!repo.enabled) return 'disabled';

  return repo.status;
};

const runLine = (run: DaemonStatus['active'][number]) => {
  if (run.parked) return 'waiting';

  return Option.getOrElse(run.currentStep, () => 'starting');
};

export const describeStatus = (status: DaemonStatus, now: DateTime.Utc) => {
  const finished = status.recent.filter((run) => run.status !== 'running');
  const upSince = Option.match(DateTime.make(status.startedAt), { onNone: () => status.startedAt, onSome: (at) => DateTime.formatLocal(at, { dateStyle: 'short', timeStyle: 'medium' }) });

  const flowLine = (flow: DaemonStatus['repos'][number]['flows'][number]) => {
    const name = `${flow.name}${asSuffix(Option.fromUndefinedOr(flow.persona))}`;

    if (!flow.enabled) return `  ${name}: off${suffix(Option.filter(Option.fromUndefinedOr(flow.offReason), (reason) => reason !== FLOW_TURNED_OFF), ', ')}`;

    const elsewhere = flow.assignedElsewhere ?? [];

    return `  ${name}: ${flow.schedule}, next ${relative(flow.next, now)}${when(elsewhere.length > 0, `; assigned elsewhere: ${elsewhere.join(', ')}`)}`;
  };

  return [
    `daemon ${status.pid}, up since ${upSince}${when(status.reloadPending, ', restarting on new config when idle')}`,
    '',
    ...status.repos.flatMap((repo) => [`${repo.name} (${repo.slug}): ${repoLine(repo)}${suffix(repo.launcher, ', launcher ')}${suffix(repo.message, ' — ')}`, ...repo.flows.map(flowLine)]),
    '',
    Option.match(Arr.head(status.active), { onNone: () => 'nothing in flight', onSome: () => 'in flight:' }),
    ...status.active.map((run) => `  ${shortRunId(run.id)}  ${runLabel(run)}  ${runLine(run)}${suffix(run.itemTitle, '  ')}`),
    ...Option.toArray(Option.map(Arr.head(finished), () => '\nrecent:')),
    ...finished.slice(0, 8).map((run) => `  ${run.status.padEnd(11)} ${shortRunId(run.id)}  ${runLabel(run)}  ${Option.getOrElse(run.summary, () => '')}`),
    ...Option.toArray(Option.map(Arr.head(status.skips), () => '\nrecent skips:')),
    ...status.skips.slice(0, 5).map((skip) => `  ${skip.repo}/${skip.flow}${suffix(Option.map(skip.persona, (login) => `@${login}`), '')}${suffix(skip.itemKey, ' ')}: ${skip.reason} (${relative(Option.some(skip.at), now)})`),
  ];
};

const trustLine = (tree: Result.Result<string, unknown>, trusted: Option.Option<string>) => {
  if (Result.isFailure(tree)) return 'no .chernabog/ on its base branch';

  if (Option.contains(trusted, tree.success)) return 'trusted';

  return 'not trusted';
};

const statusHandler = Effect.gen(function* () {
  const live = yield* Effect.result(daemonStatus);

  if (Result.isSuccess(live)) return yield* printLines(describeStatus(live.success, yield* DateTime.now));

  yield* Console.log(live.failure.message);
  const machine = yield* loadMachineConfig;

  for (const repo of machine.repos) {
    const tree = yield* Effect.result(configTree(repo.path, repo.baseBranch ?? 'main', false));
    yield* Console.log(`${repoNameOf(repo)} (${repo.repo}): ${trustLine(tree, yield* trustedTree(repo.repo))}`);
  }
});

const status = Command.make('status', {}, () => statusHandler).pipe(Command.withDescription('What the daemon is doing: repos, schedules, runs in flight, recent runs and skips'));

const installCommand = Command.make('install', {}, () => Effect.flatMap(install, Console.log)).pipe(
  Command.withDescription('Register the daemon with launchd (macOS) or systemd (Linux) and start it'),
);

const uninstallCommand = Command.make('uninstall', {}, () => Effect.flatMap(uninstall, Console.log)).pipe(Command.withDescription('Stop the daemon and remove its service'));
const start = Command.make('start', {}, () => Effect.flatMap(startService, Console.log)).pipe(Command.withDescription('Start the daemon'));
const stop = Command.make('stop', {}, () => Effect.flatMap(stopService, Console.log)).pipe(Command.withDescription('Stop the daemon; runs in flight resume when it starts again'));

const daemon = Command.make('daemon', {}, () =>
  Effect.gen(function* () {
    const code = yield* runDaemon;

    if (code === RELOAD_EXIT_CODE) process.exitCode = code;
  }),
).pipe(Command.withDescription('Run the daemon in the foreground (the service runs this; it logs to daemon.log in the chernabog home)'));

const isRunning = (row: Option.Option<RunRow>) => Option.exists(row, (found) => found.status === 'running');

// Prints a run's log as it grows, until the run finishes.
const followRun = (runId: string) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(runId));
    const poll = tail.pipe(Effect.andThen(daemonRunRow(runId)));
    const row = yield* poll.pipe(Effect.repeat({ schedule: Schedule.spaced('2 seconds'), while: isRunning }));
    yield* tail;

    return row;
  });

const reportFinished = (finished: Option.Option<RunRow>) =>
  Effect.gen(function* () {
    if (Option.isNone(finished)) return;

    yield* Console.log(`${finished.value.status}: ${Option.getOrElse(finished.value.summary, () => '')}`);

    if (finished.value.status === 'failed') process.exitCode = 1;
  });

const followStarted = (result: TickResult, detach: boolean) =>
  Effect.gen(function* () {
    const runId = Arr.head(result.started);

    if (Option.isNone(runId)) return yield* Console.log(Option.getOrElse(result.skipped, () => 'nothing to start: the trigger found no work without a run already in flight'));

    yield* Console.log(`started ${runId.value}, log: ${yield* runLogFile(runId.value)}`);

    if (detach) return;

    yield* reportFinished(yield* followRun(runId.value));
  });

const asFlag = Flag.String('as').pipe(Flag.withDescription('The GitHub persona to act as, for a flow that runs as several'), Flag.optional);

const personaField = (persona: Option.Option<string>) => Option.match(persona, { onNone: () => ({}), onSome: (login) => ({ persona: login }) });

const run = Command.make(
  'run',
  {
    flow: Argument.String('flow'),
    repo: repoFlag,
    item: Flag.String('item').pipe(Flag.withDescription('A work item key the trigger reports, such as issue-12'), Flag.optional),
    fromCheckout: Flag.Boolean('from-checkout').pipe(
      Flag.withDescription("Run in this process with the working copy's .chernabog/, to try a change (the daemon must be stopped)"),
      Flag.withDefault(false),
    ),
    detach: Flag.Boolean('detach').pipe(Flag.withDescription('Start the run and return without following its log'), Flag.withDefault(false)),
    as: asFlag,
  },
  ({ as, detach, flow, fromCheckout, item, repo }) =>
    Effect.gen(function* () {
      if (!fromCheckout) {
        const viaDaemon = yield* Effect.result(daemonRun({ repo, flow, item, ...personaField(as) }));

        if (Result.isSuccess(viaDaemon)) return yield* followStarted(viaDaemon.success, detach);

        // Refused, the daemon is running and said no; unavailable, run here instead.
        if (Predicate.isTagged(viaDaemon.failure, 'DaemonRefused')) return yield* fail(viaDaemon.failure.message);
      }

      yield* reportFinished(yield* runInForeground({ repo, flow, item, fromCheckout, persona: as }));
    }),
).pipe(Command.withDescription('One run of a flow now, skipping gates; through the daemon when it is running'));

const trigger = Command.make('trigger', { flow: Argument.String('flow'), repo: repoFlag, as: asFlag }, ({ as, flow, repo }) =>
  Effect.gen(function* () {
    const result = yield* daemonTick({ repo, flow, item: Option.none(), ...personaField(as) });

    const said = Option.match(Option.liftPredicate(result.started, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => Option.getOrElse(result.skipped, () => 'nothing to start'),
      onSome: (started) => `started ${started.join(', ')}`,
    });

    yield* Console.log(said);
  }),
).pipe(Command.withDescription("Run a flow's tick now, with its gates, as if its schedule came due"));

const pause = Command.make('pause', { repo: repoArgument }, ({ repo }) =>
  Effect.gen(function* () {
    const enrolled = yield* findEnrolled(yield* loadMachineConfig, repo);
    yield* setPaused(repoNameOf(enrolled), true);
    yield* Console.log(`paused ${repoNameOf(enrolled)}: no new runs start; runs in flight continue`);
  }),
).pipe(Command.withDescription('Start no new runs in a repo'));

const resume = Command.make('resume', { repo: repoArgument }, ({ repo }) =>
  Effect.gen(function* () {
    const enrolled = yield* findEnrolled(yield* loadMachineConfig, repo);
    yield* setPaused(repoNameOf(enrolled), false);
    yield* Console.log(`resumed ${repoNameOf(enrolled)}`);
  }),
).pipe(Command.withDescription('Let a paused repo start runs again'));

const logs = Command.make(
  'logs',
  { run: Argument.String('run'), follow: Flag.Boolean('follow').pipe(Flag.withAlias('f'), Flag.withDefault(false)) },
  ({ follow, run: named }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runId = yield* resolveRunId(named);
      const path = yield* runLogFile(runId);

      if (!(yield* fs.exists(path))) return yield* fail(`no log for ${runId} at ${path}`);

      if (follow) return yield* followRun(runId).pipe(Effect.asVoid);

      yield* Console.log((yield* fs.readFileString(path)).trimEnd());
    }),
).pipe(Command.withDescription("Print a run's log"));

const targetsOf = (repo: Option.Option<string>) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;

    if (Option.isSome(repo)) return { machine, targets: [yield* findEnrolled(machine, repo.value)] };

    return { machine, targets: machine.repos };
  });

const trust = Command.make('trust', { repo: optionalRepo }, ({ repo }) =>
  Effect.gen(function* () {
    const { targets } = yield* targetsOf(repo);
    let changed = false;

    for (const enrolled of targets) {
      const name = repoNameOf(enrolled);
      const tree = yield* configTree(enrolled.path, enrolled.baseBranch ?? 'main');
      const previous = yield* trustedTree(enrolled.repo);

      if (Option.contains(previous, tree)) {
        yield* Console.log(`${name}: already trusted (${tree.slice(0, 8)})`);
        continue;
      }

      yield* Console.log(`${name}: ${yield* trustDiff(enrolled.path, previous, tree)}`);
      yield* recordTrust(enrolled.repo, tree);
      yield* Console.log(`${name}: trusted ${tree.slice(0, 8)}`);
      changed = true;
    }

    if (changed) yield* daemonReload.pipe(Effect.ignore);
  }),
).pipe(Command.withDescription(".chernabog/ on a repo's base branch: show what changed since it was last trusted, and trust it"));

const doctorCommand = Command.make('doctor', {}, () =>
  Effect.gen(function* () {
    const checks = yield* doctor;
    yield* printLines(checks.map(formatCheck));

    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  }),
).pipe(Command.withDescription('Check logins, gh scopes, labels, trust and the daemon'));

const labels = Command.make(
  'labels',
  {
    repo: optionalRepo,
    fromCheckout: Flag.Boolean('from-checkout').pipe(
      Flag.withDescription("Read the labels from the working copy's .chernabog/, to create them before it is merged"),
      Flag.withDefault(false),
    ),
  },
  ({ fromCheckout, repo }) =>
    Effect.gen(function* () {
      const { machine, targets } = yield* targetsOf(repo);

      for (const enrolled of targets) {
        const { configDir } = yield* repoConfigDir(enrolled, fromCheckout);
        const { settings } = yield* loadRepo(machine, enrolled, configDir);
        const flows = yield* loadFlows(configDir);
        yield* Console.log(yield* syncLabels(enrolled.repo, withFlowLabels(desiredLabels(settings.labels), flows.values())));
      }
    }),
).pipe(Command.withDescription("Create or correct each repo's labels, and those its flows declare"));

// The repo a path is in; the working directory's when none is given.
const rootOf = (path: Option.Option<string>) => repoRoot(Option.getOrElse(path, () => '.'));

const init = Command.make('init', { path: Argument.String('path').pipe(Argument.optional) }, ({ path }) =>
  Effect.gen(function* () {
    const root = yield* rootOf(path);
    const written = yield* scaffold(root);

    yield* printLines(
      Option.match(Option.liftPredicate(written, Arr.isReadonlyArrayNonEmpty), {
        onNone: () => ['.chernabog/ is already set up; nothing written'],
        onSome: (files) => files.map((file) => `wrote ${file}`),
      }),
    );

    yield* Console.log('Next: commit .chernabog/, merge it to the base branch, then chernabog enroll and chernabog trust here.');
  }),
).pipe(Command.withDescription('Scaffold .chernabog/ in a repo with the default flows'));

// The flows to run on this machine: --flows when given, else asked in a
// terminal, else none chosen, which leaves local.yaml's choices as they are.
const chosenFlows = <R>(root: string, flag: Option.Option<string>, login: Effect.Effect<Option.Option<string>, never, R>) =>
  Effect.gen(function* () {
    if (Option.isSome(flag)) {
      const names = flag.value.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
      yield* checkFlowNames(root, names);

      return Option.some(names);
    }

    const stdio = yield* Stdio.Stdio;
    const choices = yield* flowChoices(root, login);

    if (choices.length === 0 || !(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) return Option.none<Array<string>>();

    const picked = yield* Prompt.MultiSelect({
      message: 'Which flows should run on this machine?',
      choices: choices.map((choice) => ({ title: choice.name, value: choice.name, selected: choice.enabled, description: Option.getOrUndefined(choice.teamOff) })),
    });

    return Option.some(picked);
  });

const enrollCommand = Command.make(
  'enroll',
  {
    path: Argument.String('path').pipe(Argument.optional),
    account: Flag.String('account').pipe(Flag.withDescription('The account from machine config whose budget this repo spends'), Flag.optional),
    name: Flag.String('name').pipe(Flag.withDescription('A short name, when two enrolled repos share one'), Flag.optional),
    flows: Flag.String('flows').pipe(
      Flag.withDescription('The flows to run on this machine, comma-separated; the rest are turned off in local.yaml. Asked in a terminal when left out'),
      Flag.optional,
    ),
  },
  ({ account, flows, name, path }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(path);
      // Looked up once, and only if the repo names runners.
      const logins = yield* Cache.make({ capacity: 1, lookup: () => Effect.option(viewerLogin) });
      const login = Cache.get(logins, 'login');
      const chosen = yield* chosenFlows(root, flows, login);
      const { action, repo } = yield* enroll(root, { account, name });

      yield* Console.log(`${action} ${repo.repo} (${repo.path}, base ${repo.baseBranch ?? 'main'}) in ${yield* machineConfigFile}`);

      if (yield* ensureLocalConfig(root)) yield* Console.log('wrote .chernabog/local.yaml');

      for (const names of Option.toArray(chosen)) {
        const choices = yield* chooseFlows(root, names, login);

        const listed = (enabled: boolean) =>
          Option.getOrElse(Option.liftPredicate(choices.filter((choice) => choice.enabled === enabled).map((choice) => choice.name).join(', '), (text) => text.length > 0), () => 'none');

        yield* Console.log(`flows on this machine: ${listed(true)}; turned off: ${listed(false)} (in .chernabog/local.yaml)`);
      }

      // A running daemon restarts to schedule the repo; none running is fine.
      yield* daemonReload.pipe(Effect.ignore);
      yield* Console.log(`Next: chernabog trust ${repoNameOf(repo)}`);
    }),
).pipe(Command.withDescription("Add a repo to this machine's config, and choose which of its flows run here"));

const attach = Command.make('attach', { run: Argument.String('run') }, ({ run: named }) =>
  Effect.gen(function* () {
    const runId = yield* resolveRunId(named);
    const session = Arr.last(yield* runSessions(runId));

    if (Option.isNone(session)) return yield* fail(`${runId} has opened no agent session`);

    const { args, command, cwd, env } = yield* attachCommand(session.value);
    yield* Console.log(`Attaching to ${session.value.adapter} session ${session.value.sessionId} in ${cwd}`);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const agent = ChildProcess.make(command, [...args], { cwd, env, extendEnv: false, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', forceKillAfter: '5 seconds' });

    yield* spawner.spawn(agent).pipe(
      Effect.flatMap((handle) => handle.exitCode),
      Effect.scoped,
      Effect.catch((error) => fail(`could not start ${command}: ${describeError(error)}`)),
    );
  }),
).pipe(Command.withDescription("Open a run's agent session in the agent's own interactive UI, in its worktree"));

const stepChild = Command.make('__step', {}, () => runStepChild.pipe(Effect.provide(StepServicesLive)));

// What a launcher runs: the agent, in the foreground of its terminal.
const launchChild = Command.make('__launch', { spec: Argument.String('spec') }, ({ spec }) =>
  Effect.map(runLaunch(spec), (code) => {
    process.exitCode = code;
  }),
);

// Claude's Stop hook in an interactive session.
const stopHookChild = Command.make('__stop-hook', { dir: Flag.String('dir') }, ({ dir }) => Effect.flatMap(stopHook(dir), Option.match({ onNone: () => Effect.void, onSome: Console.log })));

// With no subcommand, in a terminal: the live view. Piped, the status instead.
const live = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;

  if (yield* stdio.stdoutIsTerminal) return yield* runTui;

  return yield* statusHandler;
});

export const chernabog = Command.make('chernabog', {}, () => live).pipe(
  Command.withDescription('Spends spare coding-agent capacity on queued work across your repos'),
  Command.withSubcommands([
    status,
    attach,
    run,
    trigger,
    logs,
    pause,
    resume,
    trust,
    labels,
    doctorCommand,
    init,
    enrollCommand,
    installCommand,
    uninstallCommand,
    start,
    stop,
    daemon,
    Command.unlisted(stepChild),
    Command.unlisted(launchChild),
    Command.unlisted(stopHookChild),
  ]),
);

const PlatformLive = Layer.mergeAll(BunServices.layer, HostEnvironment.layer, Home.layer);

// One GitHubTokens for the process, so each persona's token is looked up once.
const AppLive = GitHubApi.layerFor(IMPLICIT).pipe(
  Layer.provideMerge(GitHubTokens.layer),
  Layer.provideMerge(Layer.mergeAll(Exec.layer, FetchHttpClient.layer)),
  Layer.provideMerge(PlatformLive),
);

if (import.meta.main) {
  Command.run(chernabog, { version: VERSION }).pipe(
    Effect.catch((error) => fail(`chernabog: ${describeError(error)}`)),
    Effect.provide(AppLive),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}
