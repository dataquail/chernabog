// One long-running daemon per machine schedules every enrolled repo's flows,
// records state in SQLite, and serves the CLI and TUI over a local socket. It
// is the only process that runs the workflow engine.

import { describeError } from "@chernabog/core";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { manualSchedule, nothingNamed } from "../../kernel/manual-flow.value-object.ts";
import { IMPLICIT, type Persona, samePersona } from "../../kernel/persona.value-object.ts";
import { RepoSlug } from "../../kernel/repo-slug.id.ts";
import { RunId, runLabel } from "../../kernel/run-id.id.ts";
import { EnrollmentQueries } from "../../modules/enrollment/enrollment.query-handlers.ts";
import {
  causeOf,
  DEFAULT_EVENT_TICK_MIN,
  eventTickAt,
  localCause,
  noteEvent,
  type PendingTick,
} from "../../modules/runs/domain/schedule/event-tick.value-object.ts";
import {
  DEFAULT_LEASE_LIMITS,
  leaseTtlFor,
  renewalDue,
  RunLeases,
} from "../../modules/runs/domain/schedule/lease.value-object.ts";
import { nextTick } from "../../modules/runs/domain/schedule/schedule.value-object.ts";
import {
  type CheckFailures,
  DEFAULT_VALIDITY_EVERY,
  noteCheckFailure,
  runIsAbout,
  RunValidity,
  validityDue,
} from "../../modules/runs/domain/schedule/validity.value-object.ts";
import {
  type FlowHandle,
  flowHandle,
  flowLayer,
} from "../../modules/runs/infrastructure/runtime/engine.ts";
import { describeLauncher } from "../../modules/runs/infrastructure/runtime/launchers.ts";
import {
  adoptRuns,
  buildPersonaContexts,
  flowOrigins,
  type PersonaContext,
  servicesFrom,
} from "../../modules/runs/infrastructure/runtime/repo-runtime.ts";
import { runLogWriting } from "../../modules/runs/infrastructure/runtime/runlog.ts";
import {
  RunFlowsCommands,
  RunFlowsCommandsLive,
} from "../../modules/runs/runs.command-handlers.ts";
import {
  type FlowRegistry,
  NotificationsLayer,
  RuntimeLayer,
  StateLive,
} from "../../modules/runs/runs.layer.ts";
import {
  RunFlowsQueries,
  RunFlowsQueriesLive,
  RunsQueries,
  RunsQueriesLive,
} from "../../modules/runs/runs.query-handlers.ts";
import { CancelledRun, CancelTarget } from "../../modules/runs/use-cases/cancel-run.result.ts";
import { cancelRunUseCase } from "../../modules/runs/use-cases/cancel-run.use-case.ts";
import { deliverSignalsUseCase } from "../../modules/runs/use-cases/deliver-signals.use-case.ts";
import { gateFlowUseCase } from "../../modules/runs/use-cases/gate-flow.use-case.ts";
import { type NotificationNews } from "../../modules/runs/use-cases/notifications.result.ts";
import { pollNotificationsUseCase } from "../../modules/runs/use-cases/poll-notifications.use-case.ts";
import { pollRunUseCase } from "../../modules/runs/use-cases/poll-run.use-case.ts";
import { recordSkipUseCase } from "../../modules/runs/use-cases/record-skip.use-case.ts";
import { recoverRunsUseCase } from "../../modules/runs/use-cases/recover-runs.use-case.ts";
import { releaseMarkersUseCase } from "../../modules/runs/use-cases/release-markers.use-case.ts";
import { type ActiveRun, type RunView } from "../../modules/runs/use-cases/run.result.ts";
import { RunHistory } from "../../modules/runs/use-cases/run-history.result.ts";
import { TrustCommands } from "../../modules/trust/trust.command-handlers.ts";
import { TrustQueries } from "../../modules/trust/trust.query-handlers.ts";
import { IncompatibleConfig } from "../../platform/config-error.ts";
import { configTree, snapshotConfig } from "../../platform/config-snapshot.ts";
import { describeSource, flowSourceOf, loadFlows } from "../../platform/flow-loader.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { acquireLock } from "../../platform/lock.ts";
import { fileIdentity, watchedExecutable } from "../../platform/self.ts";
import {
  checkFlowSettings,
  checkManualSchedules,
  type EffectiveRepo,
  EnrolledRepo,
  eventsFor,
  flowOff,
  loadMachineConfig,
  loadRepo,
  type MachineConfig,
  type PersonaRepo,
  repoNameOf,
  scheduleFor,
} from "../../repo-config.ts";
import {
  CancelRequest,
  DaemonStatus,
  type PersonaStatus,
  Refusal,
  Reloaded,
  type RepoStatus,
  RunReply,
  RunRequest,
  TickResult,
} from "./daemon.protocol.ts";

// Exits with this when the config changed, so launchd or systemd starts it again on the new config.
export const RELOAD_EXIT_CODE = 75;

// One persona's schedule of one flow. The flow's handle, and so its workflow,
// is shared by its personas; `own` is the repo as this persona runs it.
type FlowSchedule = {
  readonly handle: FlowHandle;
  readonly persona: Persona;
  readonly own: PersonaRepo;
  // None for a manual flow, which never ticks on a schedule.
  readonly expression: Option.Option<string>;
  // The schedule without the persona's own: the team's, or the flow's.
  readonly teamExpression: Option.Option<string>;
  next: Option.Option<DateTime.Utc>;
  lastTick: Option.Option<DateTime.Utc>;
  // What made the last tick: cron, manual, or the event that asked for it.
  lastCause: Option.Option<string>;
  // A tick events asked for, not run yet, and when the last such tick ran (#138).
  pending: Option.Option<PendingTick>;
  lastEventTick: Option.Option<DateTime.Utc>;
  queued: ReadonlyArray<string>;
  // What the last tick's trigger left for others, with why, and said waits
  // on someone, with who and why.
  elsewhere: ReadonlyArray<string>;
  waiting: ReadonlyArray<string>;
};

export type RepoState = {
  readonly enrolled: EnrolledRepo;
  readonly name: string;
  readonly status: RepoStatus["status"];
  readonly message: Option.Option<string>;
  readonly tree: Option.Option<string>;
  readonly repo: Option.Option<EffectiveRepo>;
  readonly flows: ReadonlyArray<FlowSchedule>;
  latestTree: Option.Option<string>;
};

const checkoutExists = (enrolled: EnrolledRepo) =>
  FileSystem.FileSystem.use((fs) => fs.exists(enrolled.path)).pipe(
    Effect.orElseSucceed(() => false),
  );

// Snapshots a repo's .chernabog/ from its default branch and loads its flows,
// unless the snapshot is not the tree that was trusted. A repo whose checkout
// is gone is paused, its settings kept, until the checkout is back or
// chernabog init points it at the checkout's new place.
export const loadRepoState = (
  machine: MachineConfig,
  enrolled: EnrolledRepo,
  index: number,
  now: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const name = repoNameOf(enrolled);
    const unloaded = { enrolled, name, repo: Option.none(), flows: [] };

    // A repo this binary can't run is incompatible, and says which side to upgrade.
    const failed = (
      error: { readonly _tag: string; readonly message: string },
      tree: Option.Option<string>,
    ): RepoState => ({
      ...unloaded,
      status: Option.getOrElse(
        Option.liftPredicate("incompatible" as const, () => Schema.is(IncompatibleConfig)(error)),
        () => "error" as const,
      ),
      message: Option.some(describeError(error)),
      tree,
      latestTree: tree,
    });

    if (!(yield* checkoutExists(enrolled))) {
      return {
        ...unloaded,
        status: "missing",
        message: Option.some(`checkout missing at ${enrolled.path}`),
        tree: Option.none(),
        latestTree: Option.none(),
      } satisfies RepoState;
    }

    const snapshot = yield* Effect.result(snapshotConfig(enrolled.path));

    if (Result.isFailure(snapshot)) {
      return failed(snapshot.failure, Option.none());
    }

    const { configDir, tree } = snapshot.success;

    const trusted = (yield* (yield* TrustQueries).FindTrustedTreeQuery({
      repo: RepoSlug.make(enrolled.repo),
    })).tree;

    if (!Option.contains(trusted, tree)) {
      const message = Option.match(trusted, {
        onNone: () => `not trusted yet; run chernabog trust ${name}`,
        onSome: () =>
          `.chernabog/ changed on the default branch; review it with chernabog trust ${name}`,
      });

      return {
        ...unloaded,
        status: "untrusted",
        message: Option.some(message),
        tree: Option.some(tree),
        latestTree: Option.some(tree),
      } satisfies RepoState;
    }

    const loaded = yield* Effect.result(
      Effect.all({
        repo: loadRepo(machine, enrolled, configDir),
        flows: loadFlows(configDir),
      }).pipe(
        Effect.tap(({ flows, repo }) => checkManualSchedules(repo, flows)),
        Effect.tap(({ flows, repo }) => checkFlowSettings(repo, flows)),
      ),
    );

    if (Result.isFailure(loaded)) {
      return failed(loaded.failure, Option.some(tree));
    }

    const { flows, repo } = loaded.success;
    const originOf = yield* flowOrigins(enrolled, tree);

    return {
      enrolled,
      name,
      status: "ready",
      message: Option.none(),
      tree: Option.some(tree),
      repo: Option.some(repo),
      flows: [...flows].flatMap(([flowName, flow]): ReadonlyArray<FlowSchedule> => {
        const handle = flowHandle(repo, flowName, flow, Option.some(originOf(flowName)));

        return repo.personas.map((own) => {
          const expression = scheduleFor(own, flowName, flow, index, machine.repos.length);

          const teamExpression = scheduleFor(
            {
              ...own,
              flows: own.teamFlows,
              schedule: { own: Option.none(), repo: own.schedule.repo },
            },
            flowName,
            flow,
            index,
            machine.repos.length,
          );

          return {
            handle,
            persona: own.persona,
            own,
            expression,
            teamExpression,
            next: Option.flatMap(expression, (cron) => nextTick(cron, now)),
            lastTick: Option.none(),
            lastCause: Option.none(),
            pending: Option.none(),
            lastEventTick: Option.none(),
            queued: [],
            elsewhere: [],
            waiting: [],
          };
        });
      }),
      latestTree: Option.some(tree),
    } satisfies RepoState;
  });

export type TickOptions = {
  readonly gates: boolean;
  readonly item: Option.Option<string>;
  // What made the tick, as status shows it.
  readonly cause: string;
};

// The least time between two event ticks of a repo's flows: the team's limits.eventTickMin.
const eventTickMinOf = (repo: RepoState) =>
  Option.getOrElse(
    Option.map(repo.repo, (loaded) => loaded.eventTickMin),
    () => DEFAULT_EVENT_TICK_MIN,
  );

// How often a repo's runs in flight have their work item checked: the team's limits.validityEvery.
const validityEveryOf = (repo: RepoState) =>
  Option.getOrElse(
    Option.map(repo.repo, (loaded) => loaded.validityEvery),
    () => DEFAULT_VALIDITY_EVERY,
  );

// How long a repo's runs' claims last, and how often they're renewed: the team's lease limits.
const leasesOf = (repo: RepoState) =>
  Option.getOrElse(
    Option.map(repo.repo, (loaded) => loaded.leases),
    () => DEFAULT_LEASE_LIMITS,
  );

// The lease on one claim of a run in flight, as status shows it.
type LeaseNote = {
  readonly item: string;
  readonly expiresAt: Option.Option<string>;
  readonly renewedAt: Option.Option<string>;
  readonly atRisk: Option.Option<string>;
};

// An item a trigger reported, with the signals it saw for it.
type WakingItem = { readonly key: string; readonly signals?: ReadonlyArray<string> };

const isGone = Predicate.isTagged("Gone");

// The runs of an issue or pull request a notification was about, by the
// repo's name and the number: their check, pending until its burst settles,
// and when they were last checked for one.
type NotifiedItem = {
  readonly repo: string;
  readonly number: number;
  pending: Option.Option<PendingTick>;
  lastChecked: Option.Option<DateTime.Utc>;
};

// How often the daemon looks for repos whose runs are due a validity check,
// unless a notification asks sooner.
const VALIDITY_POLL = Duration.seconds(30);

// When a schedule's pending event tick runs, if one is pending.
const eventDueAt = (repo: RepoState, schedule: FlowSchedule) =>
  Option.map(schedule.pending, (pending) =>
    eventTickAt(pending, schedule.lastEventTick, eventTickMinOf(repo)),
  );

// Marks the schedules an event is for as due, each by the event tick rules.
// A manual flow never ticks on a schedule, so no event ticks it either.
const markDue = (schedules: ReadonlyArray<FlowSchedule>, cause: string, at: DateTime.Utc) => {
  const ticking = schedules.filter((found) => Option.isSome(found.expression));

  for (const schedule of ticking) {
    schedule.pending = Option.some(noteEvent(schedule.pending, cause, at));
  }

  return ticking.length > 0;
};

// The personas this machine polls notifications for: each of github:'s logins
// whose events say so, or the implicit persona when there are none.
const notifiedPersonas = (machine: MachineConfig): ReadonlyArray<Persona> =>
  Option.match(Option.liftPredicate(machine.github, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => [IMPLICIT],
    onSome: (logins) => logins.map((login): Persona => Option.some(login)),
  }).filter((persona) => eventsFor(machine, persona).notifications);

// How long a persona whose notifications poll failed waits to try again.
const NOTIFICATIONS_RETRY = Duration.minutes(5);

const formatOption = (at: Option.Option<DateTime.Utc>) => Option.map(at, DateTime.formatIso);

const sameTree = Option.makeEquivalence(Equivalence.String);

// Running on an older tree than its default branch's, which isn't trusted yet.
const stale = (repo: RepoState) => repo.status === "ready" && !sameTree(repo.latestTree, repo.tree);

// Waiting on trust: never loaded for it, or running on a tree since replaced.
const untrusted = (repo: RepoState) => repo.status === "untrusted" || stale(repo);

// What the daemon schedules from the enrolled repos: one added, removed or
// moved, or any of its settings changed, such as a flow turned on for a
// persona, the daemon must restart to schedule it anew.
const sameEnrolled = Schema.toEquivalence(Schema.Array(EnrolledRepo));

const sameLogins = Equivalence.Array(Equivalence.String);

// How a schedule names itself in the log: repo/flow, and @login for a persona.
const scheduleName = (repo: string, schedule: FlowSchedule) =>
  `${repo}/${schedule.handle.name}${Option.match(schedule.persona, { onNone: () => "", onSome: (login) => `@${login}` })}`;

// The roles a persona can give an account: the team's flows' roles, and its own picks.
const rolesOf = (own: PersonaRepo) =>
  Arr.dedupe([
    ...Object.values(own.teamFlows).flatMap((flow) => Object.keys(flow.agents ?? {})),
    ...Object.keys(own.own.roles ?? {}),
  ]);

const personaStatus = (own: PersonaRepo): PersonaStatus => ({
  ...Option.match(own.persona, { onNone: () => ({}), onSome: (persona) => ({ persona }) }),
  account: own.settings.account.name,
  ownAccount: Option.fromUndefinedOr(own.own.account),
  roles: rolesOf(own).map((role) => ({
    role,
    account: Option.fromUndefinedOr(own.own.roles?.[role]),
  })),
});

const checkoutChange = (missing: boolean) => {
  if (missing) {
    return "missing";
  }

  return "back";
};

const changedAction = (trusted: boolean) => {
  if (trusted) {
    return "trusted, restarting on it when idle";
  }

  return "not trusted, starting no new runs until chernabog trust";
};

// Why a draining daemon starts nothing.
const DRAINING =
  "chernabog was upgraded; the daemon is draining, starting no new runs until it restarts on the new version";

const SOONEST_MS = 200;
const LATEST_MS = 15_000;

// The finished runs status reports, newest first.
const RECENT_RUNS = 100;

const PathParams = Schema.Struct({ id: RunId });

// Every run in flight, whatever its repo, persona or flow.
const everyRun = { repo: Option.none(), persona: Option.none(), flow: Option.none() };

export const runDaemon = Effect.gen(function* () {
  const paths = homePaths((yield* Home).root);
  const fs = yield* FileSystem.FileSystem;
  yield* acquireLock(paths.engineLock, "daemon");
  const daemonLog = yield* runLogWriting(paths.daemonLog);
  const log = daemonLog.log;
  const machine = yield* loadMachineConfig;
  const startedAt = yield* DateTime.now;

  const repos = yield* Effect.forEach(machine.repos, (enrolled, index) =>
    loadRepoState(machine, enrolled, index, startedAt),
  );

  for (const repo of repos) {
    const message = Option.match(repo.message, { onNone: () => "", onSome: (said) => `: ${said}` });

    const flows = Option.match(Option.liftPredicate(repo.flows, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => "",
      onSome: (found) =>
        ` (flows: ${Arr.dedupe(found.map((flow) => flow.handle.name)).join(", ")})`,
    });

    yield* log(`${repo.name}: ${repo.status}${message}${flows}`);
  }

  if (machine.github.length > 0) {
    yield* log(`acting on GitHub as ${machine.github.join(", ")}`);
  }

  const busy = yield* Ref.make(0);

  // Wakes the scheduling loop early, when an event makes a tick due.
  const wake = yield* Latch.make();

  // A change a run here made, in a repo by its name: every flow of it whose
  // persona ticks on local events is due once the event tick rules allow,
  // save those `spared` leaves to cron.
  const noteLocal = (
    repoName: string,
    cause: string,
    spared: (schedule: FlowSchedule) => boolean = () => false,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;

      const marked = repos
        .filter((repo) => repo.name === repoName || repo.enrolled.repo === repoName)
        .some((repo) =>
          markDue(
            repo.flows.filter(
              (schedule) => eventsFor(machine, schedule.persona).local && !spared(schedule),
            ),
            cause,
            now,
          ),
        );

      if (marked) {
        yield* wake.open;
      }
    });

  const hooks = {
    onStep: () => Ref.update(busy, (count) => count + 1),
    onStepDone: () => Ref.update(busy, (count) => count - 1),
    onChange: noteLocal,
  };

  // Each repo's services, once per persona.
  const contexts = new Map<string, ReadonlyArray<PersonaContext>>();

  for (const repo of repos) {
    if (Option.isSome(repo.repo)) {
      contexts.set(repo.name, yield* buildPersonaContexts(repo.repo.value, machine));
    }
  }

  const handles = Arr.dedupe(repos.flatMap((repo) => repo.flows.map((flow) => flow.handle)));

  const flowLayers = handles.flatMap((handle) =>
    Option.toArray(
      Option.map(Option.fromUndefinedOr(contexts.get(handle.repo.settings.name)), (personas) =>
        flowLayer(handle, servicesFrom(personas), hooks),
      ),
    ),
  );

  // What the runs module drives a tick through: the flows loaded here, each
  // with its persona's services, and their workflows in the engine.
  const registry: FlowRegistry = {
    handles,
    services: (repoName, persona) =>
      Option.flatMap(Option.fromUndefinedOr(contexts.get(repoName)), (personas) =>
        servicesFrom(personas)(persona),
      ),
  };

  const engine = yield* Layer.build(
    Layer.mergeAll(RunFlowsCommandsLive, RunFlowsQueriesLive).pipe(
      Layer.provideMerge(
        RuntimeLayer(registry).pipe(
          Layer.provideMerge(
            Layer.mergeAll(RunsQueriesLive, ...flowLayers).pipe(Layer.provideMerge(StateLive)),
          ),
        ),
      ),
    ),
  );

  return yield* Effect.provideContext(
    Effect.gen(function* () {
      // Runs in flight that started under an SDK this binary doesn't run go
      // to a person, released as a cancel releases them, rather than resume.
      for (const { reason, run } of (yield* (yield* RunsQueries).ListUnsupportedRunsQuery()).runs) {
        const ended = yield* cancelRunUseCase(CancelTarget.cases.ById.make({ asked: run.id }), {
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some({ ending: "needs-human", reason }),
        }).pipe(Effect.result);

        yield* log(
          Result.match(ended, {
            onSuccess: (done) =>
              [
                `ended ${run.id} (${runLabel(run)}) for a person: ${reason}`,
                ...done.leftForPerson,
              ].join("; "),
            onFailure: (error) =>
              `could not end ${run.id} (${runLabel(run)}), which ${reason}: ${error.message}`,
          }),
        );
      }

      for (const repo of repos) {
        if (Option.isSome(repo.repo)) {
          yield* adoptRuns(repo.repo.value);
        }
      }

      // Starts that a crash interrupted, finished before anything ticks.
      const recovered = yield* recoverRunsUseCase();

      for (const run of recovered.executed) {
        yield* log(`started ${run.id} (${runLabel(run)}), which a crash interrupted`);
      }

      for (const run of recovered.abandoned) {
        yield* log(
          `ended ${run.id} (${runLabel(run)}): a crash interrupted its start, and it kept no work item to start it from`,
        );
      }

      for (const run of recovered.left) {
        yield* log(`left ${run.id} (${runLabel(run)}) unstarted: its flow isn't loaded`);
      }

      const reloadPending = yield* Ref.make(false);
      // Set once chernabog's binary changes under the daemon: it starts no new
      // runs, and restarts on the new binary once none is executing.
      const draining = yield* Ref.make(false);
      const executable = yield* watchedExecutable;

      const startedAs = yield* Option.match(executable, {
        onNone: () => Effect.succeedNone,
        onSome: fileIdentity,
      });

      const reloaded = yield* Deferred.make<true>();

      const active = RunsQueries.use((runs) => runs.ListActiveRunsQuery(everyRun)).pipe(
        Effect.map((found) => found.runs),
      );

      // Each run in flight whose stillValid keeps failing: how often in a
      // row, and why. Status shows them; the runs carry on.
      const checkFailures = new Map<string, CheckFailures>();

      // Ends a run whose work item went as superseded, released as a cancel
      // releases it; its agent sessions stay open.
      const supersede = (run: ActiveRun, reason: string) =>
        cancelRunUseCase(CancelTarget.cases.ById.make({ asked: run.id }), {
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some({ ending: "superseded", reason }),
        }).pipe(
          Effect.result,
          Effect.flatMap((ended) =>
            log(
              Result.match(ended, {
                onSuccess: (done) =>
                  [
                    `superseded ${run.id} (${runLabel(run)}): ${Option.getOrElse(done.run.summary, () => reason)}`,
                    ...done.leftForPerson,
                  ].join("; "),
                onFailure: (error) =>
                  `could not end ${run.id} (${runLabel(run)}) as superseded (${reason}): ${error.message}`,
              }),
            ),
          ),
        );

      // A check that failed: logged when the run's checks start failing, and
      // counted for status. The run carries on.
      const noteFailure = (run: ActiveRun, message: string) =>
        Effect.gen(function* () {
          const previous = Option.fromUndefinedOr(checkFailures.get(run.id));
          checkFailures.set(run.id, noteCheckFailure(previous, message));

          if (Option.isNone(previous)) {
            yield* log(
              `${run.id} (${runLabel(run)}): stillValid failed: ${message}; the run carries on`,
            );
          }
        });

      // The leases of each run in flight, as their last check found them, and
      // when this daemon last renewed each run's.
      const leaseNotes = new Map<string, ReadonlyArray<LeaseNote>>();
      const leasesRenewed = new Map<string, DateTime.Utc>();

      // Ends a run whose claim another run took over as lost. What it left on
      // the item, worktree included, stays for the run that took it over.
      const loseRun = (run: ActiveRun, reason: string) =>
        cancelRunUseCase(CancelTarget.cases.ById.make({ asked: run.id }), {
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some({ ending: "lost", reason }),
        }).pipe(
          Effect.result,
          Effect.flatMap((ended) =>
            log(
              Result.match(ended, {
                onSuccess: (done) =>
                  `lost ${run.id} (${runLabel(run)}): ${Option.getOrElse(done.run.summary, () => reason)}`,
                onFailure: (error) =>
                  `could not end ${run.id} (${runLabel(run)}) as lost (${reason}): ${error.message}`,
              }),
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              leaseNotes.delete(run.id);
              leasesRenewed.delete(run.id);
            }),
          ),
        );

      // Checks, or renews, a run's leases: whether it still holds its work
      // item. A run that lost it ends as lost; a check that fails leaves the
      // lease at risk, and the run running.
      const checkLeases = (run: ActiveRun, renew: Option.Option<Duration.Duration>) =>
        Effect.gen(function* () {
          const found = yield* (yield* RunFlowsCommands).CheckRunLeasesCommand({
            runId: run.id,
            renew,
          });

          const known = leaseNotes.get(run.id) ?? [];

          yield* RunLeases.match(found, {
            Held: ({ leases }) =>
              Effect.sync(() => {
                leaseNotes.set(
                  run.id,
                  leases.map((lease) => ({ ...lease, atRisk: Option.none() })),
                );
              }),
            Lost: ({ reason }) => loseRun(run, reason),
            CheckFailed: ({ message }) =>
              Effect.sync(() => {
                leaseNotes.set(
                  run.id,
                  known.map((lease) => ({ ...lease, atRisk: Option.some(message) })),
                );
              }),
            Unchecked: () => Effect.void,
          });

          return !Predicate.isTagged(found, "Lost");
        });

      // Renews the leases of every run in flight whose renewal is due, in
      // every repo, paused or draining included: a run in flight still holds
      // its work. A parked run's lease lasts the longer parkedLeaseTtl.
      const renewLeases = Effect.gen(function* () {
        const now = yield* DateTime.now;

        for (const run of yield* active) {
          const limits = Option.match(
            Option.fromUndefinedOr(repos.find((repo) => repo.name === run.repo)),
            { onNone: () => DEFAULT_LEASE_LIMITS, onSome: leasesOf },
          );

          if (
            !renewalDue(Option.fromUndefinedOr(leasesRenewed.get(run.id)), limits.renewEvery, now)
          ) {
            continue;
          }

          leasesRenewed.set(run.id, now);
          yield* checkLeases(run, Option.some(leaseTtlFor(limits, run.parked)));
        }
      }).pipe(Effect.catchCause((cause) => log(`renewing runs' leases failed: ${String(cause)}`)));

      // Asks whether a run still holds its work item, and whether the item is
      // still valid: a run whose claim another run took over ends as lost,
      // and one whose item went as superseded. Whether the run carries on.
      const checkRun = (run: ActiveRun) =>
        Effect.gen(function* () {
          if (!(yield* checkLeases(run, Option.none()))) {
            return false;
          }

          const found = yield* (yield* RunFlowsQueries).CheckRunValidityQuery({ runId: run.id });

          if (!Predicate.isTagged(found, "CheckFailed")) {
            checkFailures.delete(run.id);
          }

          yield* RunValidity.match(found, {
            CheckFailed: ({ message }) => noteFailure(run, message),
            // Its claim may have been taken over since its leases were
            // checked: a run that lost its item ends as lost, not superseded.
            Gone: ({ reason }) =>
              Effect.gen(function* () {
                if (yield* checkLeases(run, Option.none())) {
                  yield* supersede(run, reason);
                }
              }),
            Valid: () => Effect.void,
            Unchecked: () => Effect.void,
          });

          return !isGone(found);
        });

      // The signalled items whose parked run still has its work item: a run
      // whose item went ends as superseded instead of waking.
      const stillWaking = <Item extends WakingItem>(
        ref: { readonly repo: string; readonly flow: string; readonly persona: Persona },
        items: ReadonlyArray<Item>,
      ) =>
        Effect.gen(function* () {
          const parked = (yield* active).filter(
            (run) =>
              run.parked &&
              run.repo === ref.repo &&
              run.flow === ref.flow &&
              samePersona(run.persona, ref.persona),
          );

          const waking: Array<Item> = [];

          for (const item of items) {
            const waiting = Option.filter(
              Arr.findFirst(parked, (run) => run.itemKey === item.key),
              () => (item.signals ?? []).length > 0,
            );

            const carriesOn = yield* Option.match(waiting, {
              onNone: () => Effect.succeed(true),
              onSome: checkRun,
            });

            if (carriesOn) {
              waking.push(item);
            }
          }

          return waking;
        });

      const tick = (repo: RepoState, schedule: FlowSchedule, options: TickOptions) =>
        Effect.gen(function* () {
          const { handle, own: settings, persona } = schedule;
          const ref = { repo: repo.name, flow: handle.name, persona };

          if (yield* Ref.get(draining)) {
            return { started: [], skipped: Option.some(DRAINING) } satisfies TickResult;
          }

          // Not knowing whether a repo is paused starts nothing in it.
          const paused = yield* Option.match(
            Option.liftPredicate(options, () => options.gates),
            {
              onNone: () => Effect.succeed(Result.succeed(false)),
              onSome: () =>
                Effect.result(
                  EnrollmentQueries.use((enrollment) => enrollment.ListPausedReposQuery()).pipe(
                    Effect.map((found) => found.repos.includes(RepoSlug.make(repo.enrolled.repo))),
                  ),
                ),
            },
          );

          if (Result.isFailure(paused)) {
            const reason = `could not tell whether it is paused: ${paused.failure.message}`;
            yield* recordSkipUseCase({ ...ref, itemKey: Option.none(), reason });

            return { started: [], skipped: Option.some(reason) } satisfies TickResult;
          }

          const plan = yield* (yield* RunFlowsCommands).PlanTickCommand({
            flow: ref,
            gates: options.gates,
            item: options.item,
            conditions: {
              enabled: settings.enabled,
              flowOff: flowOff(settings, handle.name),
              paused: paused.success,
              quietHours: machine.quietHours,
              activeHours: settings.activeHours,
            },
            concurrency: {
              flow: Option.getOrElse(
                Option.flatMap(Record.get(settings.flows, handle.name), (found) =>
                  Option.fromUndefinedOr(found.concurrency),
                ),
                () => handle.flow.concurrency ?? 1,
              ),
              machine: machine.concurrency,
            },
          });

          for (const routed of Option.toArray(plan.routed)) {
            schedule.lastTick = Option.some(yield* DateTime.now);
            schedule.lastCause = Option.some(options.cause);
            schedule.queued = routed.queued;
            schedule.elsewhere = routed.elsewhere;
            schedule.waiting = routed.waiting;
          }

          yield* deliverSignalsUseCase(ref, yield* stillWaking(ref, plan.signalled));

          const started: Array<RunView> = [];
          let skipped = plan.skipped;

          for (const item of plan.start) {
            // The flow's own gate holds back every item left this tick, not only this one.
            const gated = yield* Option.match(
              Option.liftPredicate(options, () => options.gates),
              {
                onNone: () => Effect.succeedNone,
                onSome: () =>
                  gateFlowUseCase(ref, item.key).pipe(Effect.map((found) => found.held)),
              },
            );

            if (Option.isSome(gated)) {
              skipped = gated;
              break;
            }

            const outcome = yield* (yield* RunFlowsCommands).StartFlowRunCommand({
              flow: ref,
              item,
            });

            for (const run of Option.toArray(Option.filter(outcome.run, () => outcome.started))) {
              yield* log(`started ${run.id} (${runLabel(run)})`);
              started.push(run);
            }
          }

          return {
            started: started.map((run) => run.id),
            skipped,
          } satisfies TickResult;
        }).pipe(
          Effect.catchCause((cause) =>
            log(`${scheduleName(repo.name, schedule)}: tick failed: ${String(cause)}`).pipe(
              Effect.as({ started: [], skipped: Option.some("tick failed") } satisfies TickResult),
            ),
          ),
        );

      // A repo whose flows may run: loaded, and its default branch still on the
      // trusted tree. Its services, as each persona.
      const runnable = (repo: RepoState) =>
        Option.filter(
          repo.repo,
          () => repo.status === "ready" && sameTree(repo.latestTree, repo.tree),
        ).pipe(
          Option.flatMap(() =>
            Option.map(Option.fromUndefinedOr(contexts.get(repo.name)), (personas) => ({
              contextFor: servicesFrom(personas),
            })),
          ),
        );

      // Polls running workflows and records the ones that finished.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            for (const running of yield* active) {
              const polled = yield* pollRunUseCase(running.id);
              const ended = Option.filter(polled.run, (run) => run.status !== "running");

              for (const finished of Option.toArray(ended)) {
                yield* log(
                  `finished ${finished.id} (${runLabel(finished)}): ${finished.status}: ${Option.getOrElse(finished.summary, () => "")}`,
                );
                // A run that didn't finish its work leaves its own flow to
                // cron, so a trigger whose item fails fast retries no faster.
                yield* noteLocal(
                  finished.repo,
                  localCause(`${finished.flow} run ended`, Option.none()),
                  (schedule) =>
                    finished.status !== "done" &&
                    schedule.handle.name === finished.flow &&
                    samePersona(schedule.persona, finished.persona),
                );
              }
            }

            yield* Effect.sleep("3 seconds");
          }),
        ),
      );

      // Releases the markers ended runs hold, however they ended, and tries
      // releases that failed again once their backoff is up. A failure is
      // logged the first time; status shows it until it succeeds.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const releases = yield* releaseMarkersUseCase();

            for (const marker of releases.released) {
              yield* log(`released ${marker.name} for ${marker.runId}`);
            }

            for (const marker of releases.failed.filter((failed) => failed.attempts === 1)) {
              yield* log(
                `releasing ${marker.name} for ${marker.runId} failed: ${Option.getOrElse(marker.lastError, () => "")}; trying again`,
              );
            }

            for (const marker of releases.unreleasable) {
              yield* log(
                `can't release ${marker.name} for ${marker.runId}, a person must take it off: ${Option.getOrElse(marker.lastError, () => "")}`,
              );
            }

            yield* Effect.sleep("5 seconds");
          }).pipe(
            Effect.catchCause((cause) =>
              log(`releasing markers failed: ${String(cause)}`).pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
              ),
            ),
          ),
        ),
      );

      // Runs each flow's trigger when its schedule comes due.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* wake.close;
            const now = yield* DateTime.now;
            const ticking = !(yield* Ref.get(draining));

            for (const repo of repos.filter(() => ticking)) {
              const ready = runnable(repo);

              if (Option.isNone(ready)) {
                continue;
              }

              for (const schedule of repo.flows) {
                const due = (at: Option.Option<DateTime.Utc>) =>
                  Option.exists(at, (next) => DateTime.isLessThanOrEqualTo(next, now));

                const cron = due(schedule.next);
                const event = due(eventDueAt(repo, schedule));

                if (!cron && !event) {
                  continue;
                }

                // Cron's tick reads the same state an event's would, so it covers what's pending.
                const cause = Option.getOrElse(
                  Option.map(
                    Option.filter(schedule.pending, () => !cron),
                    causeOf,
                  ),
                  () => "cron",
                );

                if (cron) {
                  schedule.next = Option.flatMap(schedule.expression, (expression) =>
                    nextTick(expression, now),
                  );
                } else {
                  schedule.lastEventTick = Option.some(now);
                }

                schedule.pending = Option.none();
                const context = ready.value.contextFor(schedule.persona);

                if (Option.isNone(context)) {
                  continue;
                }

                const result = yield* tick(repo, schedule, {
                  gates: true,
                  item: Option.none(),
                  cause,
                });

                if (Option.isSome(result.skipped)) {
                  yield* log(
                    `${scheduleName(repo.name, schedule)}: skipped: ${result.skipped.value}`,
                  );
                }
              }
            }

            const dueIn = repos
              .flatMap((repo) =>
                repo.flows.flatMap((flow) => [
                  ...Option.toArray(flow.next),
                  ...Option.toArray(eventDueAt(repo, flow)),
                ]),
              )
              .map((next) => DateTime.toEpochMillis(next) - DateTime.toEpochMillis(now));

            // An event that makes a tick due wakes the loop before the sleep is out.
            yield* Effect.timeoutOrElse(wake.await, {
              duration: Math.max(SOONEST_MS, Math.min(LATEST_MS, ...dueIn)),
              orElse: () => Effect.void,
            });
          }),
        ),
      );

      // When each repo's runs were last checked, by its name.
      const validityChecked = new Map<string, DateTime.Utc>();
      const validityWake = yield* Latch.make();

      // Each issue or pull request a notification was about, by repo name
      // and number: its runs' check, pending until the burst settles, and
      // when they were last checked for one. Checks for one item are
      // limits.eventTickMin apart, as a flow's event ticks are.
      const notifiedItems = new Map<string, NotifiedItem>();

      const tickMinOf = (item: NotifiedItem) =>
        Option.match(Option.fromUndefinedOr(repos.find((repo) => repo.name === item.repo)), {
          onNone: () => DEFAULT_EVENT_TICK_MIN,
          onSome: eventTickMinOf,
        });

      // When a notified item's runs are checked, if a check is pending.
      const notifiedDueAt = (item: NotifiedItem) =>
        Option.map(item.pending, (pending) =>
          eventTickAt(pending, item.lastChecked, tickMinOf(item)),
        );

      // Asks for the runs of the item news is about to be checked soon; news
      // about no item waits for the interval. Whether it marked any.
      const checkSoon = (news: NotificationNews, now: DateTime.Utc) =>
        Option.match(news.item, {
          onNone: () => false,
          onSome: (number) => {
            const about = repos.filter(
              (candidate) => candidate.enrolled.repo.toLowerCase() === news.repo.toLowerCase(),
            );

            for (const repo of about) {
              const key = `${repo.name}#${number}`;

              const item = notifiedItems.get(key) ?? {
                repo: repo.name,
                number,
                pending: Option.none(),
                lastChecked: Option.none(),
              };

              item.pending = Option.some(noteEvent(item.pending, news.cause, now));
              notifiedItems.set(key, item);
            }

            return about.length > 0;
          },
        });

      // Checks the runs in flight, executing or parked, of each repo whose
      // flows may run, once its limits.validityEvery comes round, and the
      // runs of each item a notification was about, once it's due. A run
      // whose item went ends as superseded; a check that fails leaves it running.
      const checkValidity = Effect.gen(function* () {
        const now = yield* DateTime.now;

        // The notified items due now, taken before anything here can fail:
        // a pass that fails leaves none of them due, so the loop never spins
        // on one. The interval, or the next notification, checks it again.
        const notified: Array<NotifiedItem> = [];

        for (const [key, item] of notifiedItems) {
          if (Option.exists(notifiedDueAt(item), (due) => DateTime.isLessThanOrEqualTo(due, now))) {
            item.pending = Option.none();
            item.lastChecked = Option.some(now);
            notified.push(item);
          } else if (
            // Forgotten once eventTickMin has passed since its last check:
            // the next notification about it is checked as soon as it settles.
            Option.isNone(item.pending) &&
            Option.exists(item.lastChecked, (last) =>
              DateTime.isLessThanOrEqualTo(DateTime.addDuration(last, tickMinOf(item)), now),
            )
          ) {
            notifiedItems.delete(key);
          }
        }

        const running = yield* active;
        const checked = new Set<string>();
        const checking = repos.filter((candidate) => Option.isSome(runnable(candidate)));

        for (const repo of checking) {
          const last = Option.fromUndefinedOr(validityChecked.get(repo.name));

          if (!validityDue(last, validityEveryOf(repo), now)) {
            continue;
          }

          validityChecked.set(repo.name, now);

          for (const run of running.filter((found) => found.repo === repo.name)) {
            checked.add(run.id);
            yield* checkRun(run);
          }
        }

        for (const item of notified) {
          const about = running.filter(
            (run) =>
              run.repo === item.repo &&
              checking.some((repo) => repo.name === run.repo) &&
              !checked.has(run.id) &&
              runIsAbout(run, item.number),
          );

          for (const run of about) {
            checked.add(run.id);
            yield* checkRun(run);
          }
        }

        // A run that ended has no checks left to fail, and no leases.
        for (const runId of checkFailures.keys()) {
          if (!running.some((run) => run.id === runId)) {
            checkFailures.delete(runId);
          }
        }

        for (const runId of [...leaseNotes.keys(), ...leasesRenewed.keys()]) {
          if (!running.some((run) => run.id === runId)) {
            leaseNotes.delete(runId);
            leasesRenewed.delete(runId);
          }
        }
      }).pipe(
        Effect.catchCause((cause) => log(`checking runs' work items failed: ${String(cause)}`)),
      );

      // Until the next notified item's check is due, or VALIDITY_POLL (or a
      // repo's limits.validityEvery or leaseRenewEvery, if sooner) at the latest.
      const untilNextCheck = Effect.map(DateTime.now, (now) =>
        Arr.reduce(
          [...notifiedItems.values()],
          Arr.reduce(repos, VALIDITY_POLL, (soonest, repo) =>
            Duration.min(soonest, Duration.min(validityEveryOf(repo), leasesOf(repo).renewEvery)),
          ),
          (soonest, item) =>
            Option.match(notifiedDueAt(item), {
              onNone: () => soonest,
              onSome: (at) =>
                Duration.min(soonest, Duration.max(Duration.zero, DateTime.distance(now, at))),
            }),
        ),
      );

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* validityWake.close;
            yield* renewLeases;
            yield* checkValidity;
            yield* Effect.timeoutOrElse(validityWake.await, {
              duration: yield* untilNextCheck,
              orElse: () => Effect.void,
            });
          }),
        ),
      );

      // Each persona's notifications poll, and why it fails, if it does.
      const notifications = new Map<string, Option.Option<string>>();

      // Makes a persona's flows in the repo news is about due.
      const markNews = (persona: Persona, news: NotificationNews, now: DateTime.Utc) =>
        repos
          .filter((repo) => repo.enrolled.repo.toLowerCase() === news.repo.toLowerCase())
          .map((repo) =>
            markDue(
              repo.flows.filter((schedule) => samePersona(schedule.persona, persona)),
              news.cause,
              now,
            ),
          )
          .some(Boolean);

      // Polls a persona's GitHub notifications as often as GitHub asks, and makes
      // the flows it runs in a repo a notification is about due. A poll that
      // fails is shown in status, with its fix, and tried again later; its
      // flows go on ticking on cron.
      const pollNotifications = (persona: Persona) =>
        Effect.gen(function* () {
          const key = Option.getOrElse(persona, () => "");

          const who = Option.match(persona, {
            onNone: () => "",
            onSome: (named) => ` for ${named}`,
          });

          const cursor = yield* Ref.make({
            lastModified: Option.none<string>(),
            since: DateTime.formatIso(startedAt),
          });

          notifications.set(key, Option.none());

          const pollOnce = Effect.gen(function* () {
            const slugs = repos
              .filter((repo) => Option.isSome(runnable(repo)))
              .map((repo) => repo.enrolled.repo);

            const polled = yield* Effect.result(
              pollNotificationsUseCase(persona, yield* Ref.get(cursor), slugs),
            );

            if (Result.isFailure(polled)) {
              // Logged once, when it starts failing; status shows it meanwhile.
              if (!Option.exists(Option.fromUndefinedOr(notifications.get(key)), Option.isSome)) {
                yield* log(`notifications${who}: ${polled.failure.message}`);
              }

              notifications.set(key, Option.some(polled.failure.message));

              return Duration.toMillis(NOTIFICATIONS_RETRY);
            }

            notifications.set(key, Option.none());
            yield* Ref.set(cursor, {
              lastModified: polled.success.lastModified,
              since: polled.success.since,
            });

            const now = yield* DateTime.now;
            const marked = polled.success.news.map((news) => markNews(persona, news, now));

            // News about an issue or pull request may be its runs' work item going.
            const checking = polled.success.news.map((news) => checkSoon(news, now));

            if (checking.some(Boolean)) {
              yield* validityWake.open;
            }

            if (marked.some(Boolean)) {
              yield* wake.open;
            }

            return polled.success.pollIntervalMs;
          });

          return yield* Effect.forever(pollOnce.pipe(Effect.flatMap(Effect.sleep)));
        }).pipe(Effect.provide(NotificationsLayer));

      for (const persona of notifiedPersonas(machine)) {
        yield* Effect.forkScoped(pollNotifications(persona));
      }

      // Restarts the daemon on a repo's trusted tree, only the first time it does.
      const reloadOn = (repo: RepoState, tree: string) =>
        Effect.gen(function* () {
          const claim = yield* (yield* TrustCommands).ClaimReloadCommand({
            repo: RepoSlug.make(repo.enrolled.repo),
            tree,
          });

          if (claim.first) {
            yield* Ref.set(reloadPending, true);
          }
        });

      // Notices a new .chernabog/ on a config branch, GitHub's default: trusted, it restarts the
      // daemon on it once nothing is executing; untrusted, the repo starts no new runs.
      const checkConfig = Effect.gen(function* () {
        for (const repo of repos) {
          const tree = yield* Effect.result(configTree(repo.enrolled.path));

          if (Result.isFailure(tree) || Option.contains(repo.latestTree, tree.success)) {
            continue;
          }

          repo.latestTree = Option.some(tree.success);

          const trusted = Option.contains(
            (yield* (yield* TrustQueries).FindTrustedTreeQuery({
              repo: RepoSlug.make(repo.enrolled.repo),
            })).tree,
            tree.success,
          );

          yield* log(
            `${repo.name}: .chernabog/ changed (${tree.success.slice(0, 8)}); ${changedAction(trusted)}`,
          );

          if (trusted) {
            yield* reloadOn(repo, tree.success);
          }
        }

        // A repo trusted since: restart so it loads. One that failed to load
        // on a trusted tree doesn't; restarting on the same tree won't help.
        for (const repo of repos) {
          if (!untrusted(repo) || Option.isNone(repo.latestTree)) {
            continue;
          }

          const trusted = (yield* (yield* TrustQueries).FindTrustedTreeQuery({
            repo: RepoSlug.make(repo.enrolled.repo),
          })).tree;

          if (sameTree(trusted, repo.latestTree)) {
            yield* reloadOn(repo, repo.latestTree.value);
          }
        }
      });

      // Notices a checkout that went missing or came back, and restarts the
      // daemon on it once nothing is executing.
      const noticed = new Set<string>();

      const checkCheckouts = Effect.gen(function* () {
        for (const repo of repos) {
          const missing = !(yield* checkoutExists(repo.enrolled));

          if (noticed.has(repo.name) || missing === (repo.status === "missing")) {
            continue;
          }

          noticed.add(repo.name);
          yield* log(
            `${repo.name}: checkout ${checkoutChange(missing)} at ${repo.enrolled.path}; restarting on it when idle`,
          );
          yield* Ref.set(reloadPending, true);
        }
      });

      // Notices a repo enrolled, dropped or changed in machine config since
      // the daemon started, and restarts the daemon on it once nothing is executing.
      let enrolledChanged = false;

      const checkEnrolled = Effect.gen(function* () {
        const current = yield* Effect.option(loadMachineConfig);

        if (
          enrolledChanged ||
          Option.isNone(current) ||
          (sameEnrolled(current.value.repos, machine.repos) &&
            sameLogins(current.value.github, machine.github))
        ) {
          return;
        }

        enrolledChanged = true;
        yield* log("enrolled repos changed; restarting on them when idle");
        yield* Ref.set(reloadPending, true);
      });

      // Notices chernabog's binary changing under the daemon, as a Homebrew
      // upgrade changes it, and drains it to restart on the new one.
      const checkExecutable = Effect.gen(function* () {
        if (yield* Ref.get(draining)) {
          return;
        }

        for (const path of Option.toArray(executable)) {
          const now = yield* fileIdentity(path);

          if (Option.isNone(now) || Option.isNone(startedAs) || now.value === startedAs.value) {
            continue;
          }

          yield* Ref.set(draining, true);
          yield* log(
            `chernabog changed at ${path}; draining: starting no new runs, and restarting on it once the runs executing now finish (runs parked on a signal resume after)`,
          );
        }
      });

      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep("5 minutes").pipe(Effect.andThen(checkConfig))),
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("10 seconds").pipe(
            Effect.andThen(checkCheckouts),
            Effect.andThen(checkEnrolled),
            Effect.andThen(checkExecutable),
          ),
        ),
      );

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("2 seconds");

            // Draining waits on whole runs, not steps: one restarted between two
            // steps would resume under the new binary.
            if (yield* Ref.get(draining)) {
              const executing = (yield* active).filter((run) => !run.parked);

              if (executing.length === 0) {
                yield* Deferred.succeed(reloaded, true);
              }

              return;
            }

            if ((yield* Ref.get(reloadPending)) && (yield* Ref.get(busy)) === 0) {
              yield* Deferred.succeed(reloaded, true);
            }
          }),
        ),
      );

      const repoStatus = (paused: ReadonlyArray<RepoSlug>) => (repo: RepoState) => {
        const offReason = (schedule: FlowSchedule) => flowOff(schedule.own, schedule.handle.name);

        const status: RepoStatus = {
          name: repo.name,
          slug: repo.enrolled.repo,
          status: repo.status,
          message: repo.message,
          paused: paused.includes(RepoSlug.make(repo.enrolled.repo)),
          enabled: Option.match(repo.repo, {
            onNone: () => true,
            onSome: (settings) => settings.personas.some((own) => own.enabled),
          }),
          tree: repo.tree,
          launcher: Option.map(repo.repo, (loaded) => describeLauncher(loaded.settings)),
          flows: repo.flows.map((flow) => ({
            name: flow.handle.name,
            ...Option.match(flow.persona, {
              onNone: () => ({}),
              onSome: (persona) => ({ persona }),
            }),
            schedule: Option.getOrElse(flow.expression, () =>
              manualSchedule(flow.handle.name, flow.handle.flow.start === true),
            ),
            // A manual flow has no schedule, the team's or anyone's.
            ...Option.match(flow.teamExpression, {
              onNone: () => ({ manual: true }),
              onSome: (teamSchedule) => ({ teamSchedule }),
            }),
            ...Option.match(
              Option.fromUndefinedOr(flow.own.own.flows?.[flow.handle.name]?.schedule),
              { onNone: () => ({}), onSome: (ownSchedule) => ({ ownSchedule }) },
            ),
            // A pending event tick is the next one, when it comes before cron's.
            next: formatOption(
              Option.match(eventDueAt(repo, flow), {
                onNone: () => flow.next,
                onSome: (event) =>
                  Option.some(
                    Option.match(flow.next, {
                      onNone: () => event,
                      onSome: (cron) => DateTime.min(cron, event),
                    }),
                  ),
              }),
            ),
            lastTick: formatOption(flow.lastTick),
            ...Option.match(flow.lastCause, {
              onNone: () => ({}),
              onSome: (lastCause) => ({ lastCause }),
            }),
            ...Option.match(flow.pending, {
              onNone: () => ({}),
              onSome: (pending) => ({ pending: causeOf(pending) }),
            }),
            queued: flow.queued,
            assignedElsewhere: flow.elsewhere,
            ...Option.match(Option.liftPredicate(flow.waiting, Arr.isReadonlyArrayNonEmpty), {
              onNone: () => ({}),
              onSome: (waiting) => ({ waiting }),
            }),
            ...Option.match(Option.fromUndefinedOr(flow.handle.flow.start), {
              onNone: () => ({}),
              onSome: (start) => ({ start }),
            }),
            ...Option.match(flowSourceOf(flow.handle.flow), {
              onNone: () => ({}),
              onSome: (source) => ({ source: describeSource(source) }),
            }),
            enabled: Option.isNone(offReason(flow)),
            ...Option.match(offReason(flow), {
              onNone: () => ({}),
              onSome: (reason) => ({ offReason: reason }),
            }),
          })),
          ...Option.match(repo.repo, {
            onNone: () => ({}),
            onSome: (loaded) => ({ personas: loaded.personas.map(personaStatus) }),
          }),
        };

        if (!stale(repo)) {
          return status;
        }

        return {
          ...status,
          status: "untrusted",
          message: Option.some(
            `.chernabog/ changed on the default branch; review it with chernabog trust ${repo.name}`,
          ),
        } satisfies RepoStatus;
      };

      const status = Effect.gen(function* () {
        const runsQueries = yield* RunsQueries;

        return {
          pid: process.pid,
          startedAt: DateTime.formatIso(startedAt),
          busy: yield* Ref.get(busy),
          reloadPending: yield* Ref.get(reloadPending),
          draining: yield* Ref.get(draining),
          repos: repos.map(
            repoStatus(
              yield* EnrollmentQueries.use((enrollment) => enrollment.ListPausedReposQuery()).pipe(
                Effect.map((found) => found.repos),
                Effect.orElseSucceed((): ReadonlyArray<RepoSlug> => []),
              ),
            ),
          ),
          accounts: machine.accounts.map((account) => ({
            name: account.name,
            agent: account.agent,
          })),
          active: yield* active,
          // Enough for the live view's project tabs and persona filter to
          // still have runs to show.
          recent: (yield* runsQueries.ListRecentRunsQuery({ latest: RECENT_RUNS })).runs,
          skips: (yield* runsQueries.ListRecentSkipsQuery({ latest: 20 })).skips,
          // Only a flow the daemon still schedules, and has on, holds anything:
          // an unenrolled repo's or a turned-off flow's last holds aren't current.
          holds: (yield* runsQueries.ListHoldsQuery()).holds.filter((hold) =>
            repos.some(
              (repo) =>
                repo.name === hold.repo &&
                repo.flows.some(
                  (schedule) =>
                    schedule.handle.name === hold.flow &&
                    samePersona(schedule.persona, hold.persona) &&
                    schedule.own.enabled &&
                    Option.isNone(flowOff(schedule.own, hold.flow)),
                ),
            ),
          ),
          notifications: [...notifications].map(([persona, problem]) => ({
            ...Option.match(
              Option.liftPredicate(persona, (named) => named.length > 0),
              {
                onNone: () => ({}),
                onSome: (named) => ({ persona: named }),
              },
            ),
            problem,
          })),
          validity: [...checkFailures].map(([runId, failures]) => ({
            runId,
            failures: failures.count,
            problem: failures.message,
          })),
          leases: [...leaseNotes].flatMap(([runId, leases]) =>
            leases.map((lease) => ({ runId, ...lease })),
          ),
          markers: (yield* runsQueries.ListUnreleasedMarkersQuery()).markers,
        } satisfies DaemonStatus;
      });

      // The schedule a person names: the flow's only persona, or the one asked for.
      const findSchedule = (repoName: string, flowName: string, persona: Option.Option<string>) => {
        const repo = Arr.findFirst(
          repos,
          (candidate) => candidate.name === repoName || candidate.enrolled.repo === repoName,
        );

        if (Option.isNone(repo)) {
          return Result.fail(`no enrolled repo named ${repoName}`);
        }

        const ready = runnable(repo.value);

        if (Option.isNone(ready)) {
          return Result.fail(
            `${repo.value.name} is ${repo.value.status}: ${Option.getOrElse(repo.value.message, () => "not ready")}`,
          );
        }

        const named = repo.value.flows.filter((flow) => flow.handle.name === flowName);

        if (named.length === 0) {
          return Result.fail(
            `${repo.value.name} has no flow named ${flowName} (flows: ${Arr.dedupe(repo.value.flows.map((flow) => flow.handle.name)).join(", ")})`,
          );
        }

        const personas = named.flatMap((flow) => Option.toArray(flow.persona));

        const schedule = Option.match(persona, {
          onNone: () => Option.liftPredicate(named[0], () => named.length === 1),
          onSome: (wanted) => Arr.findFirst(named, (flow) => Option.contains(flow.persona, wanted)),
        });

        if (Option.isNone(schedule)) {
          return Result.fail(
            Option.match(persona, {
              onNone: () =>
                `${repo.value.name} runs ${flowName} as ${personas.join(", ")}; name one with --as`,
              onSome: (wanted) =>
                `${repo.value.name} doesn't run ${flowName} as ${wanted} (it runs it as ${personas.join(", ")})`,
            }),
          );
        }

        const context = ready.value.contextFor(schedule.value.persona);

        if (Option.isNone(context)) {
          return Result.fail(
            `${repo.value.name} has no services for ${scheduleName(repo.value.name, schedule.value)}`,
          );
        }

        return Result.succeed({
          repo: repo.value,
          context: context.value,
          schedule: schedule.value,
        });
      };

      const refuse = (code: number, error: string) =>
        HttpServerResponse.schemaJson(Refusal)({ error }, { status: code });

      const answer = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        handler.pipe(Effect.catch((error) => refuse(500, describeError(error))));

      const runOrTick = (gates: boolean) =>
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(RunRequest);

          if (yield* Ref.get(draining)) {
            return yield* refuse(503, DRAINING);
          }

          const found = findSchedule(body.repo, body.flow, Option.fromUndefinedOr(body.persona));

          if (Result.isFailure(found)) {
            return yield* refuse(404, found.failure);
          }

          const { repo, schedule } = found.success;

          // Nothing finds a manual flow's work, so a person must name it.
          if (Option.isNone(schedule.expression) && Option.isNone(body.item)) {
            return yield* refuse(
              400,
              nothingNamed(schedule.handle.name, schedule.handle.flow.start === true),
            );
          }

          return yield* HttpServerResponse.schemaJson(TickResult)(
            yield* tick(repo, schedule, { gates, item: body.item, cause: "manual" }),
          );
        });

      // A run a person cancels; a repo they name by its slug is the one it runs as.
      const cancel = Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CancelRequest);

        const target = CancelTarget.match(body.target, {
          ById: (byId): CancelTarget => byId,
          ByItem: (byItem): CancelTarget => ({
            ...byItem,
            repo: Option.getOrElse(
              Option.map(
                Arr.findFirst(
                  repos,
                  (candidate) =>
                    candidate.name === byItem.repo || candidate.enrolled.repo === byItem.repo,
                ),
                (found) => found.name,
              ),
              () => byItem.repo,
            ),
          }),
        });

        const cancelled = yield* cancelRunUseCase(target, {
          by: body.by,
          closeSessions: body.closeSessions,
          endAs: Option.none(),
        }).pipe(Effect.result);

        if (Result.isFailure(cancelled)) {
          return yield* refuse(409, cancelled.failure.message);
        }

        if (cancelled.success.alreadyEnded) {
          yield* log(
            `deleted the claim refs ${cancelled.success.releasedClaims.join(", ")} of ended run ${cancelled.success.run.id} (${runLabel(cancelled.success.run)})`,
          );
        } else {
          yield* log(
            `cancelled ${cancelled.success.run.id} (${runLabel(cancelled.success.run)}): ${Option.getOrElse(cancelled.success.run.summary, () => "")}`,
          );
        }

        return yield* HttpServerResponse.schemaJson(CancelledRun)(cancelled.success);
      });

      const routes = Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/status",
          answer(status.pipe(Effect.flatMap(HttpServerResponse.schemaJson(DaemonStatus)))),
        ),
        HttpRouter.add(
          "GET",
          "/runs/:id",
          answer(
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.schemaPathParams(PathParams);

              return yield* HttpServerResponse.schemaJson(RunReply)(
                (yield* RunsQueries.use((runs) => runs.FindRunQuery({ runId: id }))).run,
              );
            }),
          ),
        ),
        HttpRouter.add(
          "GET",
          "/runs/:id/history",
          answer(
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.schemaPathParams(PathParams);

              return yield* HttpServerResponse.schemaJson(RunHistory)(
                yield* RunsQueries.use((runs) => runs.ReadRunHistoryQuery({ runId: id })),
              );
            }),
          ),
        ),
        HttpRouter.add(
          "POST",
          "/reload",
          answer(
            checkConfig.pipe(
              Effect.andThen(checkCheckouts),
              Effect.andThen(checkEnrolled),
              Effect.andThen(checkExecutable),
              Effect.andThen(Ref.get(reloadPending)),
              Effect.flatMap((pending) =>
                HttpServerResponse.schemaJson(Reloaded)({ reloadPending: pending }),
              ),
            ),
          ),
        ),
        HttpRouter.add("POST", "/run", answer(runOrTick(false))),
        HttpRouter.add("POST", "/cancel", answer(cancel)),
        HttpRouter.add("POST", "/tick", answer(runOrTick(true))),
      );

      yield* fs.remove(paths.socket, { force: true });
      yield* Effect.addFinalizer(() =>
        fs.remove(paths.socket, { force: true }).pipe(Effect.ignore),
      );
      yield* Layer.build(
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(BunHttpServer.layer({ unix: paths.socket })),
        ),
      );
      yield* log(`daemon ${process.pid} listening on ${paths.socket}`);

      yield* Deferred.await(reloaded);
      const upgraded = yield* Ref.get(draining);

      yield* log(
        Option.getOrElse(
          Option.liftPredicate("restarting on the new chernabog", () => upgraded),
          () => "restarting on new config",
        ),
      );

      return RELOAD_EXIT_CODE;
    }),
    engine,
  );
}).pipe(Effect.scoped);
