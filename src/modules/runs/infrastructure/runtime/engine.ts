// Runs flows durably. Each repo's flow is an Effect workflow, journaled in
// SQLite; each work item gets its own execution, keyed by run, so one item
// never has two runs at once and a finished item can run again later. The
// engine must live in exactly one process: a second process on the same
// database takes over workflows the first is still running.

import {
  describeError,
  type Flow,
  NeedsHuman,
  type RepoSettings,
  Run,
  RunLog,
  Signals,
  Skip,
  WorkItem,
} from "@chernabog/sdk";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";

import { Home, homePaths } from "../../../../config.ts";
import { IMPLICIT, type Persona } from "../../../../kernel/persona.value-object.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import type { EffectiveRepo } from "../../../../repo-config.ts";
import { enterStepUseCase } from "../../use-cases/enter-step.use-case.ts";
import { findRunUseCase } from "../../use-cases/find-run.use-case.ts";
import { type RunOutcome } from "../../use-cases/finish-run.use-case.ts";
import { parkRunUseCase } from "../../use-cases/park-run.use-case.ts";
import { adaptersFor, AgentLive, type AgentsConfig } from "./agents.ts";
import { noHooks, runLogWriting, type StepHooks } from "./runlog.ts";
import { GitHubLive, GitLive, RepoLive, UsageLive, WorktreeLive } from "./sdk-live.ts";
import { StepRunnerLive } from "./steps.ts";
import type { GateConfig } from "./usage-gate.ts";

export const RunResult = Schema.Struct({
  status: Schema.Literals(["done", "skipped", "needs-human"]),
  summary: Schema.String,
});

export type RunResult = typeof RunResult.Type;

export class RunFailed extends Schema.TaggedError<RunFailed, { readonly brand: "RunFailed" }>()(
  "RunFailed",
  {
    message: Schema.String,
  },
) {}

// The workflow engine and its SQLite journal, in `database`.
export const EngineAt = (database: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(database.slice(0, database.lastIndexOf("/")), { recursive: true });

      return ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" })),
        Layer.provideMerge(SqliteClient.layer({ filename: database })),
      );
    }).pipe(Effect.orDie),
  );

// The repo's settings as a persona sees them: Repo.persona names it.
export const personaSettings = (settings: RepoSettings, persona: Persona): RepoSettings =>
  Option.match(persona, {
    onNone: () => settings,
    onSome: (login) => ({ ...settings, persona: login }),
  });

// The services every flow, trigger and step of one repo uses, as one persona.
export const repoServices = (
  repoSettings: RepoSettings,
  gate: GateConfig,
  agents: AgentsConfig,
  persona: Persona,
) => {
  const settings = personaSettings(repoSettings, persona);

  return Layer.mergeAll(
    RepoLive(settings),
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

// The services for a persona's runs; none for a persona the repo no longer has.
export type ServicesFor<R> = (persona: Persona) => Option.Option<Context.Context<R>>;

// The same services whatever the persona, as in tests.
export const forEveryPersona =
  <R>(services: Context.Context<R>): ServicesFor<R> =>
  () =>
    Option.some(services);

// Who a repo's runs act as when nothing says otherwise: its first persona.
export const defaultPersona = (repo: EffectiveRepo): Persona =>
  Arr.headNonEmpty(repo.personas).persona;

export type FlowHandle = {
  readonly repo: EffectiveRepo;
  readonly name: string;
  readonly flow: Flow;
  readonly workflow: Workflow.Workflow<
    string,
    typeof FlowPayload,
    typeof RunResult,
    typeof RunFailed
  >;
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

// Registers a flow's workflow with the engine. The services each run uses
// (repoServices, or fakes in tests) are built once per persona of the repo,
// chosen by the run's persona, then given the run's own Run and RunLog. One
// workflow serves every persona, so its name, and the execution ids derived
// from it, are what they were before personas.
export const flowLayer = <R>(
  handle: FlowHandle,
  servicesFor: ServicesFor<R>,
  hooks: StepHooks = noHooks,
) =>
  handle.workflow.toLayer((payload, executionId) =>
    Effect.gen(function* () {
      const runId = RunId.make(payload.runId);
      const row = (yield* findRunUseCase(runId)).run;

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

      // A step reported after its run ended changes nothing.
      const enterStep = yield* capturing((step: string) =>
        enterStepUseCase(runId, step).pipe(
          Effect.catchTags({
            RunAlreadyFinished: () => Effect.void,
            RunNotFound: () => Effect.void,
          }),
        ),
      );

      const park = yield* capturing(parkRunUseCase);

      const runLog = yield* runLogFor(payload.runId, {
        onStep: (step) => enterStep(step).pipe(Effect.andThen(hooks.onStep(step))),
        onStepDone: hooks.onStepDone,
      });

      const signals = Signals.of({
        register: (signal, deferred, token) =>
          park({ runId, signal, deferred, token }).pipe(Effect.asVoid),
      });

      const outcome = yield* handle.flow.workflow(payload.item).pipe(
        Effect.map((summary): RunResult => ({ status: "done", summary: summaryOf(summary) })),
        Effect.catch(outcomeOf),
        Effect.provideService(Run, {
          flow: handle.name,
          runId: payload.runId,
          executionId,
          item: payload.item,
        }),
        Effect.provideService(RunLog, runLog),
        Effect.provideService(Signals, signals),
        Effect.provideContext(services.value),
      );

      yield* runLog.log(`finished: ${outcome.status}: ${outcome.summary}`);

      return outcome;
    }).pipe(Effect.catchTag("RunFailed", Effect.fail), Effect.orDie),
  );

export const statusOfExit = (exit: Exit.Exit<RunResult, RunFailed>): RunOutcome => {
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
