// Opens an enrolled repo (its config layers and flows) and runs one flow in
// the foreground: `chernabog run <flow> --repo <name>`.

import { type Flow, RunLog, Runs, type WorkItem } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ConfigError, Home, homePaths } from "./config.ts";
import {
  capturing,
  defaultPersona,
  deliverSignals,
  type FlowHandle,
  flowHandle,
  flowLayer,
  pollRun,
  repoServices,
  runLogFile,
  type ServicesFor,
  startRun,
  StateLive,
  unreportedItem,
} from "./engine.ts";
import { viewerLogin } from "./GitHubApi.ts";
import { RunId, runLabel } from "./kernel/run-id.id.ts";
import { loadFlows } from "./loader.ts";
import { acquireLock } from "./lock.ts";
import { adoptImplicitRunsUseCase } from "./modules/runs/use-cases/adopt-implicit-runs.use-case.ts";
import { findRunUseCase } from "./modules/runs/use-cases/find-run.use-case.ts";
import { listActiveRunsUseCase } from "./modules/runs/use-cases/list-active-runs.use-case.ts";
import { type ActiveRun, type RunView } from "./modules/runs/use-cases/run.result.ts";
import { type Persona, samePersona } from "./persona.ts";
import {
  type EffectiveRepo,
  type EnrolledRepo,
  findEnrolled,
  loadMachineConfig,
  loadRepo,
  type MachineConfig,
  needsLogin,
  personaOf,
  type PersonaRepo,
  routingOf,
} from "./repo-config.ts";
import { routeItems } from "./schedule.ts";
import { snapshotConfig } from "./snapshot.ts";

export type OpenRepo = {
  readonly repo: EffectiveRepo;
  readonly flows: ReadonlyMap<string, Flow>;
  readonly tree: Option.Option<string>;
};

// The trusted .chernabog/ comes from the base branch; `fromCheckout` reads the
// working copy instead, for trying out a change before merging it.
export const repoConfigDir = (enrolled: EnrolledRepo, fromCheckout: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let tree = Option.none<string>();
    let configDir = `${enrolled.path}/.chernabog`;

    if (!fromCheckout) {
      const snapshot = yield* snapshotConfig(enrolled.path, enrolled.baseBranch ?? "main");
      tree = Option.some(snapshot.tree);
      configDir = snapshot.configDir;
    }

    if (!(yield* fs.exists(configDir))) {
      return yield* new ConfigError({
        message: `${enrolled.path}: no .chernabog/; run chernabog init`,
      });
    }

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
const consoleRunLog = RunLog.of({
  log: (line) => Console.error(line),
  step: () => Effect.void,
  stepDone: () => Effect.void,
});

// One repo's services as one persona, with its account, agent and launcher,
// built once at its composition point and shared by every trigger, gate and
// run of its flows as that persona.
export const buildRepoContext = (repo: PersonaRepo, machine: MachineConfig) =>
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >();

    const services = yield* Layer.build(
      Layer.mergeAll(
        repoServices(repo.settings, machine.usageGate, machine.agents, repo.persona),
        Layer.succeed(RunLog, consoleRunLog),
      ),
    );

    return Context.merge(platform, services);
  });

export type RepoContext = Effect.Success<ReturnType<typeof buildRepoContext>>;

// The services in a repo context.
export type RepoServices = RepoContext extends Context.Context<infer R> ? R : never;

export type PersonaContext = { readonly persona: Persona; readonly context: RepoContext };

// The repo's services for each of its personas.
export const buildPersonaContexts = (repo: EffectiveRepo, machine: MachineConfig) =>
  Effect.forEach(repo.personas, (own) =>
    Effect.map(buildRepoContext(own, machine), (context): PersonaContext => ({
      persona: own.persona,
      context,
    })),
  );

// Picks a run's services by its persona.
export const servicesFrom =
  (contexts: ReadonlyArray<PersonaContext>): ServicesFor<RepoServices> =>
  (persona) =>
    Option.map(
      Arr.findFirst(contexts, (candidate) => samePersona(candidate.persona, persona)),
      (found) => found.context,
    );

// Once a repo has named personas, its runs from before them become its first
// persona's, so they keep resuming and holding that persona's slots.
export const adoptRuns = (repo: EffectiveRepo) =>
  Option.match(defaultPersona(repo), {
    onNone: () => Effect.void,
    onSome: (login) => adoptImplicitRunsUseCase(repo.settings.name, login).pipe(Effect.asVoid),
  });

// Who @me and runners mean for a persona: its own login, or, for the implicit
// persona, whoever this machine is on GitHub, asked only when it matters.
export const loginOf = (repo: EffectiveRepo, persona: Persona) =>
  Option.match(persona, {
    onSome: (login) => Effect.succeedSome(login),
    onNone: () => {
      if (!needsLogin(repo)) {
        return Effect.succeed(Option.none<string>());
      }

      return Effect.option(viewerLogin);
    },
  });

// Whether a run is still running, none for a run this machine doesn't know.
const capturingRuns = capturing((runId: string) =>
  findRunUseCase(RunId.make(runId)).pipe(
    Effect.map((found) => Option.map(found.run, (run) => run.status === "running")),
  ),
);

// Runs a flow's trigger (or gate) with the repo's services, and Runs: what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns.
export const withRepo = <A, E, R>(context: Context.Context<R>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const isActive = yield* capturingRuns;

    return yield* Effect.provideContext(effect, Context.add(context, Runs, Runs.of({ isActive })));
  });

// Prints what a log file gains, from where it was last read.
export const tailer = (path: string) => {
  let offset = 0;

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(path))) {
      return;
    }

    const text = yield* fs.readFileString(path);

    if (text.length <= offset) {
      return;
    }

    const fresh = text.slice(offset);
    offset = text.length;
    yield* Console.log(fresh.trimEnd());
  }).pipe(Effect.ignore);
};

const SIGNAL_EVERY_MS = 60_000;

const followRun = (
  handle: FlowHandle,
  persona: Persona,
  run: RunView | ActiveRun,
  context: RepoContext,
) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(run.id));
    let current = run;
    let lastSignalCheck = yield* Clock.currentTimeMillis;

    while (current.status === "running") {
      yield* tail;
      yield* Effect.sleep("1 second");
      current = yield* pollRun(handle, current);
      const now = yield* Clock.currentTimeMillis;

      if (now - lastSignalCheck > SIGNAL_EVERY_MS) {
        lastSignalCheck = now;

        const items = yield* withRepo(context, handle.flow.trigger).pipe(
          Effect.orElseSucceed(() => []),
        );

        yield* deliverSignals(handle, persona, items);
      }
    }

    yield* tail;

    return current;
  });

// `persona` picks one for a repo that runs as several; with one, it's that one.
export type RunOptions = {
  readonly repo: string;
  readonly flow: string;
  readonly item: Option.Option<string>;
  readonly fromCheckout: boolean;
  readonly persona: Option.Option<string>;
};

// The persona a person asked for, which must be one of the repo's, or its only one.
export const choosePersona = (repo: EffectiveRepo, wanted: Option.Option<string>) =>
  Effect.gen(function* () {
    const logins = repo.personas.flatMap((own) => Option.toArray(own.persona));

    if (Option.isSome(wanted)) {
      const found = Arr.findFirst(repo.personas, (own) =>
        Option.contains(own.persona, wanted.value),
      );

      if (Option.isNone(found)) {
        const runs = Option.match(Arr.head(logins), {
          onNone: () => "acts as whoever this machine is on GitHub",
          onSome: () => `runs as ${logins.join(", ")}`,
        });

        return yield* new ConfigError({
          message: `${repo.settings.name} doesn't run as ${wanted.value}; it ${runs}`,
        });
      }

      return found.value.persona;
    }

    if (repo.personas.length > 1) {
      return yield* new ConfigError({
        message: `${repo.settings.name} runs as ${logins.join(", ")}; name one with --as`,
      });
    }

    return defaultPersona(repo);
  });

const describeItem = (item: { readonly key: string; readonly title?: string }) =>
  Option.match(Option.fromUndefinedOr(item.title), {
    onNone: () => item.key,
    onSome: (title) => `${item.key} (${title})`,
  });

const resume = (
  handle: FlowHandle,
  persona: Persona,
  unfinished: ActiveRun,
  context: RepoContext,
) =>
  Effect.gen(function* () {
    yield* Console.log(
      `resuming ${unfinished.id} (${runLabel(unfinished)}), log: ${yield* runLogFile(unfinished.id)}`,
    );

    if (Option.isSome(unfinished.executionId)) {
      yield* handle.workflow.resume(unfinished.executionId.value);
    }

    return Option.some(yield* followRun(handle, persona, unfinished, context));
  });

// The first item this machine may start, unless the flow leaves work for others to them.
const firstOf = (handle: FlowHandle, persona: Persona, items: ReadonlyArray<WorkItem>) =>
  Effect.gen(function* () {
    const login = yield* loginOf(handle.repo, persona);
    const own = yield* Effect.fromOption(personaOf(handle.repo, persona)).pipe(Effect.orDie);
    const routed = routeItems(items, routingOf(own, handle.name), login);

    if (routed.elsewhere.length > 0 && routed.mine.length === 0) {
      yield* Console.log(
        `left for other machines: ${routed.elsewhere.map((item) => item.key).join(", ")}; name one with --item to run it here`,
      );
    }

    return Arr.head(routed.mine);
  });

const startFirst = (
  handle: FlowHandle,
  persona: Persona,
  options: RunOptions,
  context: RepoContext,
) =>
  Effect.gen(function* () {
    const reported = yield* withRepo(context, handle.flow.trigger);

    const items = [
      ...reported,
      ...(yield* withRepo(context, unreportedItem(handle.flow, options.item, reported))),
    ].filter((candidate) => candidate.wakeOnly !== true);

    const found = yield* Option.match(options.item, {
      onNone: () => firstOf(handle, persona, items),
      onSome: (key) =>
        Effect.succeed(Option.fromUndefinedOr(items.find((candidate) => candidate.key === key))),
    });

    if (Option.isNone(found)) {
      yield* Console.log(
        Option.match(options.item, {
          onNone: () => "nothing to do: the trigger found no work for this machine",
          onSome: (key) => `the trigger found no item ${key}`,
        }),
      );

      return Option.none<RunView>();
    }

    const { run } = yield* startRun(handle, persona, found.value);

    if (Option.isNone(run)) {
      return Option.none<RunView>();
    }

    yield* Console.log(
      `started ${run.value.id} (${runLabel(run.value)}) for ${describeItem(found.value)}, log: ${yield* runLogFile(run.value.id)}`,
    );

    return Option.some(yield* followRun(handle, persona, run.value, context));
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
      const known = Option.getOrElse(
        Option.liftPredicate([...flows.keys()].join(", "), (names) => names.length > 0),
        () => "none",
      );

      return yield* new ConfigError({
        message: `${repo.settings.name} has no flow named ${options.flow} (flows: ${known})`,
      });
    }

    const handle = flowHandle(repo, options.flow, flow.value);
    yield* acquireLock(
      homePaths((yield* Home).root).engineLock,
      `run ${options.flow} --repo ${repo.settings.name}`,
    );
    const persona = yield* choosePersona(repo, options.persona);
    const contexts = yield* buildPersonaContexts(repo, machine);
    const context = yield* Effect.fromOption(servicesFrom(contexts)(persona)).pipe(Effect.orDie);

    const program = Effect.gen(function* () {
      yield* adoptRuns(repo);

      const unfinished = Arr.head(
        (yield* listActiveRunsUseCase({
          repo: Option.some(repo.settings.name),
          persona: Option.some(persona),
          flow: Option.some(options.flow),
        })).runs,
      );

      if (Option.isSome(unfinished)) {
        return yield* resume(handle, persona, unfinished.value, context);
      }

      return yield* startFirst(handle, persona, options, context);
    });

    const engine = yield* Layer.build(
      flowLayer(handle, servicesFrom(contexts)).pipe(Layer.provideMerge(StateLive)),
    );

    return yield* Effect.provideContext(program, engine);
  }).pipe(Effect.scoped);
