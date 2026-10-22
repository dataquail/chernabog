// `chernabog start <issue>`: the hybrid path. The daemon runs the repo's
// `human-initiated` flow on the issue, whatever its trigger reports, and its session
// opens under the launcher; this brings it up in front of the person who
// asked: the Orca terminal, or `tmux attach`.

import { describeError } from '@chernabog/sdk';
import * as Arr from 'effect/Array';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';

import { type AttachCommand, liveAttach, runSessions } from './agents.ts';
import { daemonRun, daemonRunRow, daemonStatus } from './client.ts';
import { ConfigError } from './config.ts';
import { HostEnvironment } from './platform/environment.ts';
import { findEnrolled, loadMachineConfig, repoNameOf } from './repo-config.ts';
import { shortRunId } from './state.ts';

export const START_FLOW = 'human-initiated';

const HYBRID_DOCS = 'https://dataquail.github.io/chernabog/work/flows/#the-hybrid-path';

// How long the session has to open before the command leaves it to `chernabog attach`.
const OPENING_POLLS = 120;

// Runs the session's attach command on this terminal, until the person leaves it.
export const openSession = (attach: AttachCommand) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const agent = ChildProcess.make(attach.command, [...attach.args], { cwd: attach.cwd, env: attach.env, extendEnv: false, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', forceKillAfter: '5 seconds' });

    return yield* spawner.spawn(agent).pipe(
      Effect.flatMap((handle) => handle.exitCode),
      Effect.scoped,
      Effect.mapError((error) => new ConfigError({ message: `could not start ${attach.command}: ${describeError(error)}` })),
    );
  });

// The repo named, else the enrolled one this directory is in, else the only one.
const repoFor = (named: Option.Option<string>) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;

    if (Option.isSome(named)) return repoNameOf(yield* findEnrolled(machine, named.value));

    const repos = machine.repos;
    const here = Arr.findFirst(repos, (repo) => process.cwd() === repo.path || process.cwd().startsWith(`${repo.path}/`));
    const only = Option.liftPredicate(repos[0], () => repos.length === 1);

    return yield* Option.match(Option.orElse(here, () => only), {
      onNone: () => Effect.fail(new ConfigError({ message: 'name the repo with --repo: this directory is in none of the enrolled repos' })),
      onSome: (repo) => Effect.succeed(repoNameOf(repo)),
    });
  });

// The run that has the issue: the one just started, or the one already in flight.
const runFor = (repo: string, key: string, started: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (Arr.isReadonlyArrayNonEmpty(started)) return Option.some(started[0]);

    const active = (yield* daemonStatus).active;

    return Option.map(
      Arr.findFirst(active, (run) => run.repo === repo && run.flow === START_FLOW && run.itemKey === key),
      (run) => run.id,
    );
  });

// Waits for the run's session to open, and opens it here; none if the run ended first, with its row.
const awaitSession = (runId: string) =>
  Effect.gen(function* () {
    const host = (yield* HostEnvironment).variables;

    for (let poll = 0; poll < OPENING_POLLS; poll++) {
      const row = yield* daemonRunRow(runId);

      if (Option.isNone(row) || row.value.status !== 'running') return { attach: Option.none<AttachCommand>(), row };

      const session = Arr.last(yield* runSessions(runId));
      const attach = yield* Option.match(session, { onNone: () => Effect.succeedNone, onSome: (record) => liveAttach(record, host) });

      if (Option.isSome(attach)) return { attach, row };

      yield* Effect.sleep('1 second');
    }

    return { attach: Option.none<AttachCommand>(), row: Option.none() };
  });

export const startIssue = (issue: number, named: Option.Option<string>, persona: Option.Option<string>) =>
  Effect.gen(function* () {
    const repo = yield* repoFor(named);
    const key = `issue-${issue}`;

    const result = yield* daemonRun({ repo, flow: START_FLOW, item: Option.some(key), ...Option.match(persona, { onNone: () => ({}), onSome: (login) => ({ persona: login }) }) }).pipe(
      Effect.catchIf(Predicate.isTagged('DaemonUnavailable'), (unavailable) => Effect.fail(new ConfigError({ message: `${unavailable.message}; the hybrid path runs through it` }))),
      Effect.catchIf(
        (error) => Predicate.isTagged(error, 'DaemonRefused') && error.message.includes(`no flow named ${START_FLOW}`),
        () => Effect.fail(new ConfigError({ message: `${repo} has no ${START_FLOW} flow in .chernabog/flows/; the hybrid path needs one: ${HYBRID_DOCS}` })),
      ),
    );

    const runId = yield* runFor(repo, key, result.started);

    if (Option.isNone(runId)) return yield* new ConfigError({ message: Option.getOrElse(result.skipped, () => `${repo} found no issue #${issue} to start`) });

    yield* Console.log(`#${issue}: run ${shortRunId(runId.value)}; opening its session…`);
    const { attach, row } = yield* awaitSession(runId.value);

    if (Option.isSome(attach)) {
      yield* Console.log(`Opening the session in ${attach.value.command}. chernabog attach ${shortRunId(runId.value)} brings it back.`);

      return yield* openSession(attach.value).pipe(Effect.asVoid);
    }

    if (Option.isSome(row)) return yield* new ConfigError({ message: `#${issue}: ${row.value.status}: ${Option.getOrElse(row.value.summary, () => '')}` });

    yield* Console.log(`The session hasn't opened yet; chernabog attach ${shortRunId(runId.value)} opens it once it has.`);
  });
