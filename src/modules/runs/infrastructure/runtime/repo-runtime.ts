// A repo as this process runs its flows: its config layers and flows, read
// from the trusted tree on its base branch (or the working copy, to try a
// change), and each persona's services, built once and shared by every
// trigger, gate and run of its flows as that persona.

import { type Flow, RunLog, type SetupError, type WorkItem } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import { type Persona, samePersona } from "../../../../kernel/persona.value-object.ts";
import { ConfigError } from "../../../../platform/config-error.ts";
import { snapshotConfig } from "../../../../platform/config-snapshot.ts";
import { loadFlows } from "../../../../platform/flow-loader.ts";
import { viewerLogin } from "../../../../platform/github-api.ts";
import {
  type EffectiveRepo,
  type EnrolledRepo,
  loadRepo,
  type MachineConfig,
  needsLogin,
  type PersonaRepo,
} from "../../../../repo-config.ts";
import { adoptImplicitRunsUseCase } from "../../use-cases/adopt-implicit-runs.use-case.ts";
import { defaultPersona, repoServices, type ServicesFor } from "./engine.ts";

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
// run of its flows as that persona. Fails with the setup error that stops the
// persona acting, such as a login gh doesn't have.
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

// A persona's services, or the setup error that stops it acting.
export type PersonaContext = {
  readonly persona: Persona;
  readonly services: Effect.Effect<RepoContext, SetupError>;
};

// One persona's services, built now, and built again each time they're asked
// for while setup fails, so a persona logged in after the daemon started acts
// without a restart.
const personaServices = (own: PersonaRepo, machine: MachineConfig) =>
  Effect.gen(function* () {
    const build = Effect.provideContext(
      buildRepoContext(own, machine),
      yield* Effect.context<Effect.Services<ReturnType<typeof buildRepoContext>>>(),
    );

    return { build, built: yield* Ref.make(yield* Effect.result(build)) };
  }).pipe(
    Effect.map(({ build, built }) => {
      const again = Effect.result(build).pipe(
        Effect.tap((result) => Ref.set(built, result)),
        Effect.flatMap(Effect.fromResult),
      );

      return Ref.get(built).pipe(
        Effect.flatMap(Result.match({ onSuccess: Effect.succeed, onFailure: () => again })),
      );
    }),
  );

// The repo's services for each of its personas.
export const buildPersonaContexts = (repo: EffectiveRepo, machine: MachineConfig) =>
  Effect.forEach(repo.personas, (own) =>
    Effect.map(personaServices(own, machine), (services): PersonaContext => ({
      persona: own.persona,
      services,
    })),
  );

// Picks a run's services by its persona.
export const servicesFrom =
  (contexts: ReadonlyArray<PersonaContext>): ServicesFor<RepoServices> =>
  (persona) =>
    Option.map(
      Arr.findFirst(contexts, (candidate) => samePersona(candidate.persona, persona)),
      (found) => found.services,
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

// The item a person named that the trigger didn't report, when the flow can
// find it by its key, as `start` finds the issue `chernabog start` names.
export const unreportedItem = (
  flow: Flow,
  named: Option.Option<string>,
  items: ReadonlyArray<WorkItem>,
) =>
  Option.match(
    Option.filter(
      Option.product(named, Option.fromUndefinedOr(flow.item)),
      ([key]) => !items.some((found) => found.key === key),
    ),
    {
      onNone: () => Effect.succeed<ReadonlyArray<WorkItem>>([]),
      onSome: ([key, find]) => Effect.map(find(key), Option.toArray),
    },
  );
