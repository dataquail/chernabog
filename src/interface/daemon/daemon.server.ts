// One long-running daemon per machine schedules every enrolled repo's flows,
// records state in SQLite, and serves the CLI and TUI over a local socket. It
// is the only process that runs the workflow engine.

import { describeError } from "@chernabog/sdk";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type FlowHandle, flowHandle, flowLayer } from "../../engine.ts";
import { type Persona } from "../../kernel/persona.value-object.ts";
import { RepoSlug } from "../../kernel/repo-slug.id.ts";
import { RunId, runLabel } from "../../kernel/run-id.id.ts";
import { describeLauncher } from "../../launchers.ts";
import { loadFlows } from "../../loader.ts";
import { listPausedReposUseCase } from "../../modules/enrollment/use-cases/list-paused-repos.use-case.ts";
import { nextTick } from "../../modules/runs/domain/schedule/schedule.value-object.ts";
import { type FlowRegistry, RuntimeLayer, StateLive } from "../../modules/runs/runs.layer.ts";
import { findRunUseCase } from "../../modules/runs/use-cases/find-run.use-case.ts";
import { listActiveRunsUseCase } from "../../modules/runs/use-cases/list-active-runs.use-case.ts";
import { listRecentRunsUseCase } from "../../modules/runs/use-cases/list-recent-runs.use-case.ts";
import { listRecentSkipsUseCase } from "../../modules/runs/use-cases/list-recent-skips.use-case.ts";
import { pollRunsUseCase } from "../../modules/runs/use-cases/poll-runs.use-case.ts";
import { recordSkipUseCase } from "../../modules/runs/use-cases/record-skip.use-case.ts";
import { tickFlowUseCase } from "../../modules/runs/use-cases/tick-flow.use-case.ts";
import { findTrustedTreeUseCase } from "../../modules/trust/use-cases/find-trusted-tree.use-case.ts";
import { viewerLogin } from "../../platform/github-api.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { acquireLock } from "../../platform/lock.ts";
import {
  type EffectiveRepo,
  EnrolledRepo,
  flowOff,
  loadMachineConfig,
  loadRepo,
  type MachineConfig,
  needsLogin,
  type PersonaRepo,
  repoNameOf,
  routingOf,
  scheduleFor,
} from "../../repo-config.ts";
import { runLogWriting } from "../../runlog.ts";
import {
  adoptRuns,
  buildPersonaContexts,
  type PersonaContext,
  servicesFrom,
} from "../../runner.ts";
import { configTree, snapshotConfig } from "../../snapshot.ts";
import {
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
  readonly expression: string;
  // The schedule without the persona's own: the team's, or the flow's.
  readonly teamExpression: string;
  next: Option.Option<DateTime.Utc>;
  lastTick: Option.Option<DateTime.Utc>;
  queued: ReadonlyArray<string>;
  // What the last tick left for other machines, by flows.<flow>.assignee and reviewRequested.
  elsewhere: ReadonlyArray<string>;
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

const baseBranchOf = (enrolled: EnrolledRepo) => enrolled.baseBranch ?? "main";

const checkoutExists = (enrolled: EnrolledRepo) =>
  FileSystem.FileSystem.use((fs) => fs.exists(enrolled.path)).pipe(
    Effect.orElseSucceed(() => false),
  );

// Snapshots a repo's .chernabog/ from its base branch and loads its flows,
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

    const failed = (message: string, tree: Option.Option<string>): RepoState => ({
      ...unloaded,
      status: "error",
      message: Option.some(message),
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

    const snapshot = yield* Effect.result(snapshotConfig(enrolled.path, baseBranchOf(enrolled)));

    if (Result.isFailure(snapshot)) {
      return failed(describeError(snapshot.failure), Option.none());
    }

    const { configDir, tree } = snapshot.success;
    const trusted = (yield* findTrustedTreeUseCase(RepoSlug.make(enrolled.repo))).tree;

    if (!Option.contains(trusted, tree)) {
      const message = Option.match(trusted, {
        onNone: () => `not trusted yet; run chernabog trust ${name}`,
        onSome: () =>
          `.chernabog/ changed on the base branch; review it with chernabog trust ${name}`,
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
      Effect.all({ repo: loadRepo(machine, enrolled, configDir), flows: loadFlows(configDir) }),
    );

    if (Result.isFailure(loaded)) {
      return failed(describeError(loaded.failure), Option.some(tree));
    }

    const { flows, repo } = loaded.success;

    return {
      enrolled,
      name,
      status: "ready",
      message: Option.none(),
      tree: Option.some(tree),
      repo: Option.some(repo),
      flows: [...flows].flatMap(([flowName, flow]): ReadonlyArray<FlowSchedule> => {
        const handle = flowHandle(repo, flowName, flow);

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
            next: nextTick(expression, now),
            lastTick: Option.none(),
            queued: [],
            elsewhere: [],
          };
        });
      }),
      latestTree: Option.some(tree),
    } satisfies RepoState;
  });

export type TickOptions = { readonly gates: boolean; readonly item: Option.Option<string> };

const formatOption = (at: Option.Option<DateTime.Utc>) => Option.map(at, DateTime.formatIso);

const sameTree = Option.makeEquivalence(Equivalence.String);

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

const SOONEST_MS = 200;
const LATEST_MS = 15_000;

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

  // Who the implicit persona is on GitHub, for repos that name their flows'
  // runners or start only work assigned to it. A persona's login is its own.
  let login = Option.none<string>();

  if (repos.some((repo) => Option.exists(repo.repo, needsLogin))) {
    const found = yield* Effect.result(viewerLogin);
    login = Result.getSuccess(found);
    yield* log(
      Result.match(found, {
        onSuccess: (self) => `this machine is ${self} on GitHub`,
        onFailure: (error) => `could not tell who this machine is on GitHub: ${error.message}`,
      }),
    );
  }

  if (machine.github.length > 0) {
    yield* log(`acting on GitHub as ${machine.github.join(", ")}`);
  }

  const loginFor = (persona: Persona) => Option.orElse(persona, () => login);

  // Several personas on one flow each see all its work unless @me tells them apart.
  for (const repo of repos) {
    for (const flow of Arr.dedupe(repo.flows.map((schedule) => schedule.handle.name))) {
      const running = repo.flows.filter(
        (schedule) =>
          schedule.handle.name === flow &&
          schedule.handle.flow.ownWork !== true &&
          Option.isNone(flowOff(schedule.own, flow)),
      );

      const unrouted = running.some(
        (schedule) =>
          Option.isNone(routingOf(schedule.own, flow).assignee) &&
          Option.isNone(routingOf(schedule.own, flow).reviewRequested),
      );

      if (running.length > 1 && unrouted) {
        yield* log(
          `${repo.name}/${flow}: runs as ${running.flatMap((schedule) => Option.toArray(schedule.persona)).join(", ")} with no assignee or reviewRequested, so each takes any of its work`,
        );
      }
    }
  }

  const busy = yield* Ref.make(0);

  const hooks = {
    onStep: () => Ref.update(busy, (count) => count + 1),
    onStepDone: () => Ref.update(busy, (count) => count - 1),
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
    RuntimeLayer(registry).pipe(
      Layer.provideMerge(
        Layer.mergeAll(Layer.empty, ...flowLayers).pipe(Layer.provideMerge(StateLive)),
      ),
    ),
  );

  return yield* Effect.provideContext(
    Effect.gen(function* () {
      for (const repo of repos) {
        if (Option.isSome(repo.repo)) {
          yield* adoptRuns(repo.repo.value);
        }
      }

      const reloadPending = yield* Ref.make(false);
      const reloaded = yield* Deferred.make<true>();

      const active = listActiveRunsUseCase(everyRun).pipe(Effect.map((found) => found.runs));

      const tick = (repo: RepoState, schedule: FlowSchedule, options: TickOptions) =>
        Effect.gen(function* () {
          const { handle, own: settings, persona } = schedule;
          const ref = { repo: repo.name, flow: handle.name, persona };

          // Not knowing whether a repo is paused starts nothing in it.
          const paused = yield* Option.match(
            Option.liftPredicate(options, () => options.gates),
            {
              onNone: () => Effect.succeed(Result.succeed(false)),
              onSome: () =>
                Effect.result(
                  listPausedReposUseCase().pipe(
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

          const outcome = yield* tickFlowUseCase(ref, {
            gates: options.gates,
            item: options.item,
            conditions: {
              enabled: settings.enabled,
              flowOff: flowOff(settings, handle.name),
              paused: paused.success,
              quietHours: machine.quietHours,
              activeHours: settings.activeHours,
            },
            routing: routingOf(settings, handle.name),
            login: loginFor(persona),
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

          for (const routed of Option.toArray(outcome.routed)) {
            schedule.lastTick = Option.some(yield* DateTime.now);
            schedule.queued = routed.queued;
            schedule.elsewhere = routed.elsewhere;
          }

          for (const run of outcome.started) {
            yield* log(`started ${run.id} (${runLabel(run)})`);
          }

          return {
            started: outcome.started.map((run) => run.id),
            skipped: outcome.skipped,
          } satisfies TickResult;
        }).pipe(
          Effect.catchCause((cause) =>
            log(`${scheduleName(repo.name, schedule)}: tick failed: ${String(cause)}`).pipe(
              Effect.as({ started: [], skipped: Option.some("tick failed") } satisfies TickResult),
            ),
          ),
        );

      // A repo whose flows may run: loaded, and its base branch still on the
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
            for (const finished of (yield* pollRunsUseCase()).runs) {
              yield* log(
                `finished ${finished.id} (${runLabel(finished)}): ${finished.status}: ${Option.getOrElse(finished.summary, () => "")}`,
              );
            }

            yield* Effect.sleep("3 seconds");
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

              if (Option.isNone(ready)) {
                continue;
              }

              for (const schedule of repo.flows) {
                if (
                  !Option.exists(schedule.next, (next) => DateTime.isLessThanOrEqualTo(next, now))
                ) {
                  continue;
                }

                schedule.next = nextTick(schedule.expression, now);
                const context = ready.value.contextFor(schedule.persona);

                if (Option.isNone(context)) {
                  continue;
                }

                const result = yield* tick(repo, schedule, {
                  gates: true,
                  item: Option.none(),
                });

                if (Option.isSome(result.skipped)) {
                  yield* log(
                    `${scheduleName(repo.name, schedule)}: skipped: ${result.skipped.value}`,
                  );
                }
              }
            }

            const dueIn = repos
              .flatMap((repo) => repo.flows.flatMap((flow) => Option.toArray(flow.next)))
              .map((next) => DateTime.toEpochMillis(next) - DateTime.toEpochMillis(now));

            yield* Effect.sleep(Math.max(SOONEST_MS, Math.min(LATEST_MS, ...dueIn)));
          }),
        ),
      );

      // Notices a new .chernabog/ on a base branch: trusted, it restarts the
      // daemon on it once nothing is executing; untrusted, the repo starts no new runs.
      const checkConfig = Effect.gen(function* () {
        for (const repo of repos) {
          const tree = yield* Effect.result(
            configTree(repo.enrolled.path, baseBranchOf(repo.enrolled)),
          );

          if (Result.isFailure(tree) || Option.contains(repo.latestTree, tree.success)) {
            continue;
          }

          repo.latestTree = Option.some(tree.success);

          const trusted = Option.contains(
            (yield* findTrustedTreeUseCase(RepoSlug.make(repo.enrolled.repo))).tree,
            tree.success,
          );

          yield* log(
            `${repo.name}: .chernabog/ changed (${tree.success.slice(0, 8)}); ${changedAction(trusted)}`,
          );

          if (trusted) {
            yield* Ref.set(reloadPending, true);
          }
        }

        for (const repo of repos) {
          const trusted = (yield* findTrustedTreeUseCase(RepoSlug.make(repo.enrolled.repo))).tree;

          if (
            repo.status !== "ready" &&
            Option.isSome(repo.latestTree) &&
            sameTree(trusted, repo.latestTree)
          ) {
            yield* Ref.set(reloadPending, true);
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

      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep("5 minutes").pipe(Effect.andThen(checkConfig))),
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("10 seconds").pipe(
            Effect.andThen(checkCheckouts),
            Effect.andThen(checkEnrolled),
          ),
        ),
      );

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("2 seconds");

            if ((yield* Ref.get(reloadPending)) && (yield* Ref.get(busy)) === 0) {
              yield* Deferred.succeed(reloaded, true);
            }
          }),
        ),
      );

      const repoStatus = (paused: ReadonlyArray<RepoSlug>) => (repo: RepoState) => {
        const stale = repo.status === "ready" && !sameTree(repo.latestTree, repo.tree);
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
            schedule: flow.expression,
            teamSchedule: flow.teamExpression,
            ...Option.match(
              Option.fromUndefinedOr(flow.own.own.flows?.[flow.handle.name]?.schedule),
              { onNone: () => ({}), onSome: (ownSchedule) => ({ ownSchedule }) },
            ),
            next: formatOption(flow.next),
            lastTick: formatOption(flow.lastTick),
            queued: flow.queued,
            assignedElsewhere: flow.elsewhere,
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

        if (!stale) {
          return status;
        }

        return {
          ...status,
          status: "untrusted",
          message: Option.some(
            `.chernabog/ changed on the base branch; review it with chernabog trust ${repo.name}`,
          ),
        } satisfies RepoStatus;
      };

      const status = Effect.gen(function* () {
        return {
          pid: process.pid,
          startedAt: DateTime.formatIso(startedAt),
          busy: yield* Ref.get(busy),
          reloadPending: yield* Ref.get(reloadPending),
          repos: repos.map(
            repoStatus(
              yield* listPausedReposUseCase().pipe(
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
          recent: (yield* listRecentRunsUseCase(20)).runs,
          skips: (yield* listRecentSkipsUseCase(20)).skips,
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
          const found = findSchedule(body.repo, body.flow, Option.fromUndefinedOr(body.persona));

          if (Result.isFailure(found)) {
            return yield* refuse(404, found.failure);
          }

          const { repo, schedule } = found.success;

          return yield* HttpServerResponse.schemaJson(TickResult)(
            yield* tick(repo, schedule, { gates, item: body.item }),
          );
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
                (yield* findRunUseCase(id)).run,
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
              Effect.andThen(Ref.get(reloadPending)),
              Effect.flatMap((pending) =>
                HttpServerResponse.schemaJson(Reloaded)({ reloadPending: pending }),
              ),
            ),
          ),
        ),
        HttpRouter.add("POST", "/run", answer(runOrTick(false))),
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
      yield* log("restarting on new config");

      return RELOAD_EXIT_CODE;
    }),
    engine,
  );
}).pipe(Effect.scoped);
