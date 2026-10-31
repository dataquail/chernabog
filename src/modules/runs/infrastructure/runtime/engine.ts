// Runs flows durably. Each repo's flow is an Effect workflow, journaled in
// SQLite; each work item gets its own execution, keyed by run, so one item
// never has two runs at once and a finished item can run again later. The
// engine must live in exactly one process: a second process on the same
// database takes over workflows the first is still running.

import {
  Agent,
  AgentError,
  CAPABILITIES,
  Capabilities,
  Claims,
  describeError,
  type Flow,
  FlowPackage,
  GitHub,
  isSetupError,
  Markers,
  NeedsHuman,
  type RepoSettings,
  Run,
  RunLog,
  Settings,
  type SetupError,
  Signals,
  Skip,
  Subjects,
  WorkItem,
} from "@chernabog/core";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";

import {
  resumesRunsFrom,
  unsupportedRunSummary,
} from "../../../../kernel/core-support.value-object.ts";
import { IMPLICIT, type Persona } from "../../../../kernel/persona.value-object.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { flowSourceOf } from "../../../../platform/flow-loader.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { checkPersona } from "../../../../platform/github-auth.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { VERSION } from "../../../../platform/version.ts";
import { type EffectiveRepo, flowSettingsInput, personaOf } from "../../../../repo-config.ts";
import { type WorkflowOutcome } from "../../domain/ports/clients/workflows.client.ts";
import { localCause } from "../../domain/schedule/event-tick.value-object.ts";
import { RunsCommands, RunsCommandsLive } from "../../runs.command-handlers.ts";
import { RunsQueries, RunsQueriesLive } from "../../runs.query-handlers.ts";
import { adaptersFor, AgentLive, type AgentsConfig } from "./agents.ts";
import { noHooks, runLogWriting, type StepHooks } from "./runlog.ts";
import {
  GitHubLive,
  GitLive,
  RepoLive,
  ReviewerSeatLive,
  UsageLive,
  WorktreeLive,
} from "./sdk-live.ts";
import { prepareState } from "./state-stamp.ts";
import { StepRunnerLive } from "./steps.ts";
import type { GateConfig } from "./usage-gate.ts";

// Lost: the run found, before a write, that another run took its work item over.
export const RunResult = Schema.Struct({
  status: Schema.Literals(["done", "skipped", "needs-human", "lost"]),
  summary: Schema.String,
});

export type RunResult = typeof RunResult.Type;

export class RunFailed extends Schema.TaggedError<RunFailed, { readonly brand: "RunFailed" }>()(
  "RunFailed",
  {
    message: Schema.String,
  },
) {}

// The workflow engine and its SQLite journal, in `database`, which a newer
// chernabog's stamp refuses, and an older one's is copied before it moves up.
export const EngineAt = (database: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const prepared = yield* prepareState((yield* Home).root, database);

      for (const kept of Option.toArray(prepared.kept)) {
        yield* Console.error(
          `chernabog: state.db: stamped chernabog ${VERSION}; a copy of it as it was is at ${kept}`,
        );
      }

      return ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" })),
        Layer.provideMerge(SqliteClient.layer({ filename: database })),
      );
    }).pipe(Effect.catchTag("PlatformError", Effect.die)),
  );

// The repo's settings as a persona sees them: Repo.persona names it.
export const personaSettings = (settings: RepoSettings, persona: Persona): RepoSettings =>
  Option.match(persona, {
    onNone: () => settings,
    onSome: (login) => ({ ...settings, persona: login }),
  });

// The services every flow, trigger and step of one repo uses, as one persona.
// Building them checks the persona has a token, so a persona that can't act
// fails here with its setup error (PersonaUnavailable, NotAuthenticated),
// before any of its flows runs, rather than partway through one.
export const repoServices = (
  repoSettings: RepoSettings,
  gate: GateConfig,
  agents: AgentsConfig,
  persona: Persona,
) => {
  const settings = personaSettings(repoSettings, persona);

  return Layer.mergeAll(
    Layer.effectDiscard(checkPersona(persona)),
    RepoLive(settings),
    ReviewerSeatLive(settings, persona),
    GitHubLive(settings).pipe(Layer.provide(GitHubApi.layerFor(persona))),
    GitLive(persona),
    WorktreeLive(settings, persona),
    UsageLive(settings, gate),
    AgentLive(settings, adaptersFor(agents), persona),
    StepRunnerLive(settings, gate, agents, persona),
  );
};

// A run's persona is in its payload; a run started before personas has none there.
const FlowPayload = Schema.Struct({
  runId: Schema.String,
  item: WorkItem,
  persona: Schema.optionalKey(Schema.String),
});

// The services for a persona's runs, which fail with the setup error that
// stops the persona acting; none for a persona the repo no longer has.
export type ServicesFor<R> = (
  persona: Persona,
) => Option.Option<Effect.Effect<Context.Context<R>, SetupError>>;

// The same services whatever the persona, as in tests.
export const forEveryPersona =
  <R>(services: Context.Context<R>): ServicesFor<R> =>
  () =>
    Option.some(Effect.succeed(services));

// A setup error raised when a flow asks for a service it can't have, such as
// a reviewer seat the persona doesn't hold, as a failure the engine reports;
// any other defect stays one.
export const surfaceSetup = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SetupError, R> =>
  Effect.catchDefect(effect, (defect): Effect.Effect<never, SetupError> => {
    if (isSetupError(defect)) {
      return Effect.fail(defect);
    }

    return Effect.die(defect);
  });

// Who a repo's runs act as when nothing says otherwise: its first persona.
export const defaultPersona = (repo: EffectiveRepo): Persona =>
  Arr.headNonEmpty(repo.personas).persona;

export const workflowName = (repo: string, flow: string) => `${repo}/${flow}`;

// The workflow a flow's runs execute in, by its name alone, for reaching an
// execution of a flow this process didn't load, or that a repo no longer has.
export const workflowNamed = (repo: string, flow: string) =>
  Workflow.make(workflowName(repo, flow), {
    payload: FlowPayload,
    idempotencyKey: (payload) => payload.runId,
    success: RunResult,
    error: RunFailed,
  });

// Where a handle's flow was loaded from: the .chernabog/ tree, and how to load
// the same flow from another tree's snapshot, for a run that started there.
export type FlowOrigin = {
  readonly tree: string;
  readonly flowAt: (tree: string) => Effect.Effect<Flow, RunFailed>;
};

export type FlowHandle = {
  readonly repo: EffectiveRepo;
  readonly name: string;
  readonly flow: Flow;
  // The tree `flow` was loaded from; none for a working copy's.
  readonly tree: Option.Option<string>;
  // The flow as the snapshot of another tree has it.
  readonly flowAt: (tree: string) => Effect.Effect<Flow, RunFailed>;
  readonly workflow: Workflow.Workflow<
    string,
    typeof FlowPayload,
    typeof RunResult,
    typeof RunFailed
  >;
};

// Without an origin, as from a working copy, every run runs `flow`.
export const flowHandle = (
  repo: EffectiveRepo,
  name: string,
  flow: Flow,
  origin: Option.Option<FlowOrigin> = Option.none(),
): FlowHandle => ({
  repo,
  name,
  flow,
  tree: Option.map(origin, (found) => found.tree),
  flowAt: Option.match(origin, {
    onNone: () => () => Effect.succeed(flow),
    onSome: (found) => found.flowAt,
  }),
  workflow: workflowNamed(repo.settings.name, name),
});

// The flow a run executes: the one loaded from the tree it started from, so
// a change merged since, or a move of the repo's SDK, never swaps the blocks
// under a run in flight. A run that recorded no tree runs the handle's.
const flowOfRun = (handle: FlowHandle, tree: Option.Option<string>) =>
  Option.match(
    Option.filter(tree, (started) => !Option.contains(handle.tree, started)),
    {
      onNone: () => Effect.succeed(handle.flow),
      onSome: handle.flowAt,
    },
  );

export const runLogFile = (runId: string) =>
  Home.use((home) => Effect.succeed(homePaths(home.root).runLog(runId)));

// A run log for `runId`, from outside its workflow.
export const runLogFor = (runId: string, hooks: StepHooks = noHooks) =>
  runLogFile(runId).pipe(Effect.flatMap((path) => runLogWriting(path, hooks)));

const summaryOf = (summary: string | void) => {
  if (Predicate.isString(summary)) {
    return summary;
  }

  return "done";
};

// How the workflow ended: Skip and NeedsHuman are outcomes, anything else a failure.
const outcomeOf = <E>(error: E) => {
  if (Schema.is(Skip)(error)) {
    return Effect.succeed<RunResult>({ status: "skipped", summary: error.reason });
  }

  if (Schema.is(NeedsHuman)(error)) {
    return Effect.succeed<RunResult>({ status: "needs-human", summary: error.reason });
  }

  return Effect.fail(new RunFailed({ message: describeError(error) }));
};

// `use`, with the services it needs captured now, for a caller that runs it
// where they aren't provided, such as a step hook.
export const capturing = <Args extends ReadonlyArray<unknown>, A, E, R>(
  use: (...args: Args) => Effect.Effect<A, E, R>,
) =>
  Effect.map(
    Effect.context<R>(),
    (context) =>
      (...args: Args) =>
        Effect.provideContext(use(...args), context),
  );

// The executions told to stop, by id. The engine's interrupt lands only
// between activities, and an activity in progress, such as an agent step an
// hour long, checks nothing. So a run told to stop ends its workflow at once,
// as an interrupt no flow can catch, and only then does the agent call it was
// in end, so nothing in the flow sees that call fail. The agent's session is
// left as it is.
type Stopping = {
  // Set when the execution is told to stop.
  readonly asked: Deferred.Deferred<void>;
  // Set once its workflow has stopped.
  readonly ended: Deferred.Deferred<void>;
};

const stopRequests = new Map<string, Stopping>();

const stoppingOf = (executionId: string) => {
  const found = stopRequests.get(executionId);

  if (Predicate.isNotUndefined(found)) {
    return found;
  }

  const made: Stopping = { asked: Deferred.makeUnsafe<void>(), ended: Deferred.makeUnsafe<void>() };
  stopRequests.set(executionId, made);

  return made;
};

// How long a stopped agent call waits for its workflow to stop before it ends
// anyway, as one in a workflow this process doesn't run would.
const STOP_GRACE = Duration.seconds(5);

// Tells a run's execution in this process to stop: its workflow ends as an
// interrupt, and then the agent call it is in, if any.
export const stopExecution = (executionId: string) =>
  Effect.suspend(() => Deferred.done(stoppingOf(executionId).asked, Exit.void)).pipe(Effect.asVoid);

// Ends a run's workflow as an interrupt once its execution is told to stop.
export const untilStopped =
  (executionId: string) =>
  <A, E, R>(workflow: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const stopping = stoppingOf(executionId);

      return Effect.raceFirst(
        Effect.asSome(workflow),
        Deferred.await(stopping.asked).pipe(Effect.as(Option.none<A>())),
      ).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })),
        Effect.ensuring(
          Deferred.done(stopping.ended, Exit.void).pipe(
            Effect.andThen(Effect.sync(() => stopRequests.delete(executionId))),
          ),
        ),
      );
    });

// The run's services, with each agent call ending once its execution is told
// to stop and its workflow has stopped.
export const stoppingWith = <R>(
  context: Context.Context<R>,
  executionId: string,
): Context.Context<R> =>
  Option.match(Context.getOption(context, Agent), {
    onNone: () => context,
    onSome: (agent) =>
      Context.add(
        context,
        Agent,
        Agent.of({
          ...agent,
          run: (request) =>
            Effect.suspend(() => {
              const stopping = stoppingOf(executionId);

              return Effect.raceFirst(
                agent.run(request),
                Deferred.await(stopping.asked).pipe(
                  Effect.andThen(
                    Deferred.await(stopping.ended).pipe(
                      Effect.timeoutOrElse({ duration: STOP_GRACE, orElse: () => Effect.void }),
                    ),
                  ),
                  Effect.andThen(
                    Effect.fail(new AgentError({ message: "the run was stopped mid-step" })),
                  ),
                ),
              );
            }),
        }),
      ),
  });

// The run's capabilities, which report the changes other flows act on: every
// write a capability declares (pull requests, pushes, reviews, labels,
// comments, other API writes…), so no flow declares them. What a port doesn't
// declare a write (a claim, Git.run), a .chernabog/stages/ step's own process
// and the agent's own gh or git aren't seen here; the run's end, or cron,
// catches those. A change is reported once made; a failed one changed nothing
// to tick for.
export const reportingChanges = <R>(
  context: Context.Context<R>,
  changed: (what: string, item: Option.Option<number>) => Effect.Effect<void>,
  capabilities: ReadonlyArray<Capabilities.Guarded> = CAPABILITIES,
): Context.Context<R> =>
  Capabilities.guardingAll(context, capabilities, (write, call) =>
    Effect.tap(call, (result) => changed(write.done, write.item(result))),
  );

// The run's capabilities, which check before each write they declare, each
// one another person or run sees, that `fence` lets it through: that every
// claim the run holds still names it. A run that lost one never gets past
// the check. A small window between the check and the write remains.
export const fencing = <R>(
  context: Context.Context<R>,
  fence: (what: string) => Effect.Effect<void>,
  capabilities: ReadonlyArray<Capabilities.Guarded> = CAPABILITIES,
): Context.Context<R> =>
  Capabilities.guardingAll(context, capabilities, (write, call) =>
    Effect.andThen(fence(write.doing), call),
  );

// The fence a run's writes pass (fencing): every claim it holds, as its
// claim-ref markers say, still names it. One that doesn't completes `lost`
// with why, which ends the workflow as lost, and the write waits until it
// does, never made. A read that fails lets the write through.
const leaseFence =
  (
    runId: string,
    github: Option.Option<GitHub["Service"]>,
    holds: Markers.MarkerHolds["Service"],
    lost: Deferred.Deferred<string>,
  ) =>
  (what: string) =>
    Effect.gen(function* () {
      if (Option.isNone(github)) {
        return;
      }

      const claims = (yield* holds.held(Claims.refMarker.name)).flatMap((args) =>
        Option.toArray(
          Option.filter(
            Schema.decodeOption(Claims.refMarker.args)(args),
            (claim) => claim.runId === runId,
          ),
        ),
      );

      for (const { item } of claims) {
        const holding = yield* Claims.holds(item, runId).pipe(
          Effect.provideService(GitHub, github.value),
          Effect.option,
        );

        for (const found of Option.toArray(holding)) {
          if (!found.held) {
            yield* Deferred.succeed(
              lost,
              `${Claims.describeLoss(item, found.holder)}; stopped before ${what}`,
            );

            return yield* Effect.interruptible(Effect.never);
          }
        }
      }
    });

// Registers a flow's workflow with the engine. The services each run uses
// (repoServices, or fakes in tests) are built once per persona of the repo,
// chosen by the run's persona, then given the run's own Run and RunLog. One
// workflow serves every persona, so its name, and the execution ids derived
// from it, are what they were before personas.
// The package a flow is imported from, for the SDK's FlowPackage; none for
// a flow in the repo.
const provideFlowPackage =
  (flow: Flow) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.match(flowSourceOf(flow), {
      onNone: () => effect,
      onSome: (source) =>
        Effect.provideService(effect, FlowPackage, {
          name: source.package,
          version: source.version,
          dir: source.dir,
        }),
    });

// The flow's settings as `persona` runs it; none for a persona the repo no longer has.
export const flowSettingsFor = (handle: FlowHandle, persona: Persona) =>
  Settings.FlowSettings.of({
    input: Option.match(personaOf(handle.repo, persona), {
      onNone: () => ({}),
      onSome: (own) => flowSettingsInput(own, handle.name),
    }),
  });

// The markers a run holds, recorded against it for their release when it
// ends. A marker neither the SDK nor the flow defines couldn't be released,
// so holding one fails.
const markerHolds = (runId: RunId, flow: Flow) =>
  Effect.gen(function* () {
    const known = new Set(
      [...Markers.builtIn, ...(flow.markers ?? [])].map((marker) => marker.name),
    );

    const hold = yield* capturing(
      (name: string, args: Schema.Json, keepOn: ReadonlyArray<string>) =>
        RunsCommands.use((runs) => runs.HoldMarkerCommand({ runId, name, args, keepOn })),
    );

    const forget = yield* capturing((name: string, args: Schema.Json) =>
      RunsCommands.use((runs) => runs.ForgetMarkerCommand({ runId, name, args })),
    );

    const held = yield* capturing((name: string) =>
      RunsQueries.use((runs) => runs.ListRunMarkersQuery({ runId, name: Option.some(name) })).pipe(
        Effect.map((found) => found.markers.map((marker) => marker.args)),
      ),
    );

    return Markers.MarkerHolds.of({
      hold: (name, args, keepOn) => {
        if (!known.has(name)) {
          return Effect.fail(Markers.unlisted(name));
        }

        return hold(name, args, keepOn).pipe(Effect.asVoid);
      },
      held,
      forget,
    });
  });

export const flowLayer = <R>(
  handle: FlowHandle,
  servicesFor: ServicesFor<R>,
  hooks: StepHooks = noHooks,
) =>
  handle.workflow
    .toLayer((payload, executionId) =>
      Effect.gen(function* () {
        const runId = RunId.make(payload.runId);
        const row = (yield* (yield* RunsQueries).FindRunQuery({ runId })).run;

        // A run started under a core this binary doesn't provide is never
        // replayed under this one: it goes to a person before any of its flow runs.
        const started = Option.flatMap(row, (found) => Option.fromUndefinedOr(found.coreVersion));

        for (const version of Option.toArray(
          Option.filter(started, (sdk) => !resumesRunsFrom(sdk)),
        )) {
          return {
            status: "needs-human",
            summary: unsupportedRunSummary(version),
          } satisfies RunResult;
        }

        const named = Option.orElse(Option.fromUndefinedOr(payload.persona), () =>
          Option.flatMap(row, (found) => found.persona),
        );

        // A run from before personas acts as the implicit persona while the repo
        // still has one, else as its first persona. Its row may not say so yet:
        // the engine can resume it before the daemon adopts it.
        const persona = Option.match(named, {
          onSome: (login): Persona => Option.some(login),
          onNone: () => {
            if (Option.isSome(servicesFor(IMPLICIT))) {
              return IMPLICIT;
            }

            return defaultPersona(handle.repo);
          },
        });

        const services = servicesFor(persona);

        if (Option.isNone(services)) {
          const who = Option.getOrElse(persona, () => "the implicit persona");

          return yield* new RunFailed({
            message: `${who} no longer runs ${handle.repo.settings.name}; add it back to the repo's personas to finish this run`,
          });
        }

        const context = yield* services.value.pipe(
          Effect.mapError((error) => new RunFailed({ message: error.message })),
        );

        // A step reported after its run ended changes nothing.
        const enterStep = yield* capturing((step: string) =>
          RunsCommands.use((runs) => runs.EnterStepCommand({ runId, step })).pipe(
            Effect.catchTags({
              RunAlreadyFinished: () => Effect.void,
              RunNotFound: () => Effect.void,
            }),
          ),
        );

        const park = yield* capturing(
          (parking: { signal: string; deferred: string; token: string }) =>
            RunsCommands.use((runs) => runs.ParkRunCommand({ runId, ...parking })),
        );

        // A subject named after its run ended changes nothing.
        const nameSubject = yield* capturing((subject: string) =>
          RunsCommands.use((runs) => runs.NameSubjectCommand({ runId, subject })).pipe(
            Effect.catchTags({
              RunAlreadyFinished: () => Effect.void,
              RunNotFound: () => Effect.void,
            }),
            Effect.asVoid,
          ),
        );

        const runLog = yield* runLogFor(payload.runId, {
          onStep: (step) => enterStep(step).pipe(Effect.andThen(hooks.onStep(step))),
          onStepDone: hooks.onStepDone,
          onChange: hooks.onChange,
        });

        const signals = Signals.of({
          register: (signal, deferred, token) =>
            park({ signal, deferred, token }).pipe(Effect.asVoid),
        });

        const flow = yield* flowOfRun(
          handle,
          Option.flatMap(row, (found) => found.configTree),
        );

        const holds = yield* markerHolds(runId, flow);
        const lost = yield* Deferred.make<string>();
        const fence = leaseFence(payload.runId, Context.getOption(context, GitHub), holds, lost);

        const outcome = yield* flow.workflow(payload.item).pipe(
          Effect.map((summary): RunResult => ({ status: "done", summary: summaryOf(summary) })),
          surfaceSetup,
          Effect.catch(outcomeOf),
          Effect.provideService(Run, {
            flow: handle.name,
            runId: payload.runId,
            executionId,
            item: payload.item,
            leaseTtl: Duration.toMillis(handle.repo.leases.ttl),
          }),
          // An imported flow's prompts and steps are looked up in its package after the repo.
          provideFlowPackage(flow),
          Effect.provideService(RunLog, runLog),
          Effect.provideService(Signals, signals),
          Effect.provideService(Markers.MarkerHolds, holds),
          Effect.provideService(
            Subjects.RunSubjects,
            Subjects.RunSubjects.of({ name: nameSubject }),
          ),
          Effect.provideService(Settings.FlowSettings, flowSettingsFor(handle, persona)),
          Effect.provideContext(
            stoppingWith(
              fencing(
                reportingChanges(context, (what, item) =>
                  hooks.onChange(handle.repo.settings.name, localCause(what, item)),
                ),
                fence,
              ),
              executionId,
            ),
          ),
          // A run that lost its item ends as lost, before any flow sees why.
          (workflow) =>
            Effect.raceFirst(
              workflow,
              Deferred.await(lost).pipe(
                Effect.map((reason): RunResult => ({ status: "lost", summary: reason })),
              ),
            ),
          // Told to stop, it ends as an interrupt, before any flow sees why.
          untilStopped(executionId),
        );

        yield* runLog.log(`finished: ${outcome.status}: ${outcome.summary}`);

        return outcome;
      }).pipe(Effect.catchTag("RunFailed", Effect.fail), Effect.orDie),
    )
    .pipe(Layer.provide(Layer.mergeAll(RunsQueriesLive, RunsCommandsLive)));

export const statusOfExit = (exit: Exit.Exit<RunResult, RunFailed>): WorkflowOutcome => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  return Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => ({
      status: "failed",
      summary: Cause.pretty(exit.cause).split("\n")[0] ?? "failed",
    }),
    onSome: (failure) => ({ status: "failed", summary: failure.message }),
  });
};
