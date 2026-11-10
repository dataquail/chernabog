// `chernabog ci run`: the run job of a repo's GitHub Actions workflow (#455,
// #460). One item on one runner, in a chernabog home of the job's own: it
// takes the item's claim, runs the flow in the foreground as `chernabog run`
// does, and ends the job at the next phase boundary. Where a run on a laptop
// would park on a signal, it lets go of the claim and exits 0; the event that
// settles the wait starts the next job, which repeats nothing the phase
// recorded. A job that stops any other way repeats its phase from the start in
// the next one, so before it exits for any reason it pushes what the agent
// left in its worktrees, and keeps the run log and the agent's transcripts
// where the workflow uploads them from.

import { Claims, Git, triggerOf, type WorkItem } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { IMPLICIT, type Persona } from "../../kernel/persona.value-object.ts";
import { type RunId, runLabel } from "../../kernel/run-id.id.ts";
import {
  buildPersonaContexts,
  EngineLive,
  type FlowHandle,
  flowHandle,
  flowLayer,
  openRepo,
  type RepoContext,
  RunFlowsCommands,
  runLogFile,
  RunsQueries,
  servicesFrom,
  withRepo,
} from "../../modules/runs/runs.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { HostEnvironment } from "../../platform/environment.ts";
import { viewerLoginAs } from "../../platform/github-api.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { acquireLock } from "../../platform/lock.ts";
import { engineRuntime } from "../application-runtime.ts";
import { tailer } from "./run.main.ts";

// How long a CI run's claim lasts unless the job renews it: short, so a job
// killed outright (a runner lost, the job cancelled past its grace) frees the
// item for the next job in minutes rather than the half day a laptop's lasts.
export const CI_LEASE_TTL = Duration.minutes(15);

// When the job stops on its own: well inside a hosted job's 6-hour limit, with
// time to push and let go of the claim before GitHub ends it.
export const CI_STOP_AFTER = Duration.minutes(330);

// The environment variable claude takes a subscription token from.
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

// How a CI run's job ended: the run ended (and how), parked at a phase
// boundary, the item was another run's, or the job ran out of time.
export type CiRunEnding =
  | { readonly kind: "ended"; readonly status: string; readonly summary: string }
  | { readonly kind: "parked" }
  | { readonly kind: "elsewhere"; readonly why: string }
  | { readonly kind: "out-of-time" };

// Why the job may not start, if it may not: a key that bills per token, or a
// home that already holds runs, as a person's does and a runner's never.
export const refusalOf = (
  variables: Readonly<Record<string, string>>,
  homeHasState: boolean,
): Option.Option<string> => {
  if (Record.has(variables, "ANTHROPIC_API_KEY")) {
    return Option.some(
      `ANTHROPIC_API_KEY is set, which claude bills per token over the subscription: unset it, and pass the subscription's token as ${OAUTH_TOKEN_ENV}`,
    );
  }

  if (homeHasState) {
    return Option.some(
      "ci run needs a home of its own, with no runs in it: set CHERNABOG_HOME to a fresh directory, such as $RUNNER_TEMP/chernabog",
    );
  }

  return Option.none();
};

// The machine config a job's home starts from when the workflow gives it
// none: the checkout, enrolled for the job's flows (a run job's one, the plan
// job's every CI flow), as the implicit persona (the job's GH_TOKEN), with
// claude on the subscription token and under tmux.
export const ciMachineConfig = (options: {
  readonly slug: string;
  readonly checkout: string;
  readonly flows: ReadonlyArray<string>;
}) => ({
  accounts: { ci: { oauthTokenEnv: OAUTH_TOKEN_ENV } },
  launcher: "tmux",
  repos: [
    {
      path: options.checkout,
      repo: options.slug,
      name: options.slug.split("/").at(-1) ?? options.slug,
      account: "ci",
      flows: Object.fromEntries(options.flows.map((flow) => [flow, {}])),
    },
  ],
});

// What a fresh runner's ~/.claude.json needs so an interactive claude starts
// at its prompt: onboarding done, and the checkout and the worktrees trusted
// (docs/ci/runner-test.md, question 1).
export const claudeSeed = (trusted: ReadonlyArray<string>) => ({
  hasCompletedOnboarding: true,
  theme: "dark",
  projects: Object.fromEntries(trusted.map((path) => [path, { hasTrustDialogAccepted: true }])),
});

// The directory claude keeps a session's transcripts in, under projects/, for
// a working directory: its path with everything but letters and digits as `-`.
export const transcriptDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

type Opened = Effect.Success<ReturnType<typeof openRepo>>;

type EffectiveRepo = Opened["repo"];

type MachineConfig = Parameters<typeof openRepo>[0];

// How the command reads machine config, which the CLI's root hands it, as it
// does `ci plan`.
export type CiRunConfigAccess<R> = (
  repo: string,
) => Effect.Effect<
  { readonly machine: MachineConfig; readonly enrolled: Parameters<typeof openRepo>[1] },
  ConfigError,
  R
>;

export type CiRunOptions = {
  readonly repo: string;
  readonly flow: string;
  readonly persona: string;
  readonly item: string;
  readonly logs: Option.Option<string>;
  readonly leaseTtl: Duration.Duration;
  readonly stopAfter: Duration.Duration;
  readonly fromCheckout: boolean;
};

const JsonText = Schema.fromJsonString(Schema.Json);

export const writeJson = (path: string, value: Schema.Json) =>
  Effect.gen(function* () {
    const text = yield* Schema.encodeEffect(JsonText)(value).pipe(Effect.orDie);
    yield* (yield* FileSystem.FileSystem).writeFileString(path, `${text}\n`);
  });

// The home's machine config, written from the job's environment when the
// workflow left none, and ~/.claude.json, seeded on a runner that has none.
const prepareHome = (options: CiRunOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const variables = (yield* HostEnvironment).variables;
    const paths = homePaths(home.root);

    const checkout = Option.getOrElse(Record.get(variables, "GITHUB_WORKSPACE"), () =>
      process.cwd(),
    );

    yield* fs.makeDirectory(home.root, { recursive: true });

    if (!(yield* fs.exists(paths.machineConfig))) {
      if (!Record.has(variables, OAUTH_TOKEN_ENV)) {
        return yield* new ConfigError({
          message: `${OAUTH_TOKEN_ENV} isn't set: claude needs the subscription's token, from claude setup-token`,
        });
      }

      const slug = Option.getOrElse(Record.get(variables, "GITHUB_REPOSITORY"), () => options.repo);
      yield* writeJson(
        paths.machineConfig,
        ciMachineConfig({ slug, checkout, flows: [options.flow] }),
      );
    }

    const claudeJson = `${home.user}/.claude.json`;

    if (Record.get(variables, "GITHUB_ACTIONS").pipe(Option.contains("true"))) {
      if (!(yield* fs.exists(claudeJson))) {
        yield* writeJson(claudeJson, claudeSeed([checkout, `${home.root}/worktrees`]));
      }
    }
  }).pipe(
    Effect.catchTag(
      "PlatformError",
      (error) => new ConfigError({ message: `preparing the home: ${error.message}` }),
    ),
  );

// The repo's persona that acts as `login`: one of machine config's, or the
// implicit one when its token is that login.
const personaOf = (repo: EffectiveRepo, login: string) =>
  Effect.gen(function* () {
    const named = Arr.findFirst(repo.personas, (own) =>
      Option.exists(own.persona, (found) => found.toLowerCase() === login.toLowerCase()),
    );

    if (Option.isSome(named)) {
      return named.value.persona;
    }

    if (repo.personas.some((own) => Option.isNone(own.persona))) {
      const implicit = yield* viewerLoginAs(IMPLICIT).pipe(
        Effect.mapError((error) => new ConfigError({ message: error.message })),
      );

      if (implicit.toLowerCase() === login.toLowerCase()) {
        return IMPLICIT;
      }
    }

    return yield* new ConfigError({
      message: `${repo.settings.name} has no persona acting as ${login} here`,
    });
  });

const refOf = (handle: FlowHandle, persona: Persona) => ({
  repo: handle.repo.settings.name,
  flow: handle.name,
  persona,
});

// Whether the trigger still reports the item to start, as the plan found it.
const stillReported = (items: ReadonlyArray<WorkItem>, key: string) =>
  Arr.findFirst(
    items,
    (found) =>
      found.key === key &&
      found.wakeOnly !== true &&
      Option.isNone(Option.fromUndefinedOr(found.held)) &&
      Option.isNone(Option.fromUndefinedOr(found.waitsOn)),
  );

const GOT_THERE_FIRST = "another run got there first";

// Follows a run until it ends, parks on a signal, loses its claim or runs out
// of the job's time, renewing its claim's short lease as it goes.
const followToBoundary = (runId: RunId, options: CiRunOptions, stopAt: number) =>
  Effect.gen(function* () {
    const commands = yield* RunFlowsCommands;
    const queries = yield* RunsQueries;
    const tail = tailer(yield* runLogFile(runId));
    const renewEvery = Duration.toMillis(options.leaseTtl) / 3;
    let renewedAt = yield* Clock.currentTimeMillis;

    for (;;) {
      yield* tail;
      const polled = yield* commands.PollRunCommand({ runId });

      for (const run of Option.toArray(polled.run)) {
        if (run.status !== "running") {
          yield* tail;

          return {
            kind: "ended",
            status: run.status,
            summary: Option.getOrElse(run.summary, () => ""),
          } satisfies CiRunEnding;
        }
      }

      const active = yield* queries.ListActiveRunsQuery({
        repo: Option.none(),
        persona: Option.none(),
        flow: Option.none(),
      });

      if (active.runs.some((run) => run.id === runId && run.parked)) {
        yield* tail;

        return { kind: "parked" } satisfies CiRunEnding;
      }

      const now = yield* Clock.currentTimeMillis;

      if (now >= stopAt) {
        return { kind: "out-of-time" } satisfies CiRunEnding;
      }

      if (now - renewedAt >= renewEvery) {
        renewedAt = now;

        const leases = yield* commands.CheckRunLeasesCommand({
          runId,
          renew: Option.some(options.leaseTtl),
        });

        if (Predicate.isTagged(leases, "Lost")) {
          return {
            kind: "elsewhere",
            why: `${leases.reason}: ${GOT_THERE_FIRST}`,
          } satisfies CiRunEnding;
        }
      }

      yield* Effect.sleep("1 second");
    }
  });

const ClaimArgs = Schema.Struct({ item: Schema.String, runId: Schema.String });

// Lets go of the claims a run holds, which a run that ended has let go already.
const releaseClaims = (runId: RunId, context: RepoContext) =>
  Effect.gen(function* () {
    const held = yield* (yield* RunsQueries).ListRunMarkersQuery({
      runId,
      name: Option.some(Claims.refMarker.name),
    });

    for (const marker of held.markers) {
      for (const args of Option.toArray(Schema.decodeUnknownOption(ClaimArgs)(marker.args))) {
        const released = yield* withRepo(context, Claims.releaseFor(args.item, args.runId)).pipe(
          Effect.orElseSucceed(() => false),
        );

        if (released) {
          yield* Console.log(`let go of the claim on ${args.item}`);
        }
      }
    }
  });

// Commits what the agent left uncommitted in each of the job's worktrees and
// pushes the branch it's on, as the persona: the next job repeats the phase
// from its start, and finds the work on the branch. A checkout on no branch,
// such as a review's, has nothing of its own to push.
const pushWorktree = (path: string, why: string) =>
  Effect.gen(function* () {
    const git = yield* Git;

    const branch = yield* git.run(["symbolic-ref", "-q", "--short", "HEAD"], path).pipe(
      Effect.map((out) => out.trim()),
      Effect.option,
    );

    if (Option.isNone(branch) || branch.value.length === 0) {
      return Option.none<string>();
    }

    if ((yield* git.run(["status", "--porcelain"], path)).trim().length > 0) {
      const identity = yield* Effect.option(git.run(["config", "user.email"], path));

      const author = Option.match(identity, {
        onSome: (): ReadonlyArray<string> => [],
        onNone: () => [
          "-c",
          "user.name=chernabog",
          "-c",
          "user.email=chernabog@users.noreply.github.com",
        ],
      });

      yield* git.run(["add", "-A"], path);
      // Work in progress, kept as the agent left it: the repo's hooks are for
      // finished work, and refusing this commit would lose it.
      yield* git.run([...author, "commit", "-q", "--no-verify", "-m", `wip: ${why}`], path);
    }

    // A plain push, never forced: a branch that moved on elsewhere keeps what it has.
    yield* git.run(["push", "-q", "origin", `HEAD:refs/heads/${branch.value}`], path);

    return Option.some(branch.value);
  });

const pushWork = (repo: EffectiveRepo, context: RepoContext, why: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = homePaths((yield* Home).root).worktrees(repo.settings.name);

    if (!(yield* fs.exists(root))) {
      return;
    }

    for (const name of yield* fs.readDirectory(root)) {
      const path = `${root}/${name}`;

      const said = yield* withRepo(context, pushWorktree(path, why)).pipe(
        Effect.map(Option.map((branch) => `pushed ${branch}`)),
        Effect.catch((error) => Effect.succeedSome(`could not push ${path}: ${error.message}`)),
      );

      for (const line of Option.toArray(said)) {
        yield* Console.log(line);
      }
    }
  });

// Copies the run log and the agent's transcripts to `dir`, for the artifact
// the workflow uploads when the job fails.
const keepLogs = (runId: Option.Option<RunId>, dir: string, claudeDirs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    yield* fs.makeDirectory(dir, { recursive: true });

    for (const id of Option.toArray(runId)) {
      const log = yield* runLogFile(id);

      if (yield* fs.exists(log)) {
        yield* fs.copyFile(log, `${dir}/${id}.log`);
      }
    }

    // A session's transcripts are under the directory named for its working
    // directory, which for a run is one of the home's worktrees.
    const worktrees = homePaths(home.root).worktrees("");

    const prefixes = Arr.dedupe([
      worktrees,
      yield* fs.realPath(home.root).pipe(
        Effect.map((root) => homePaths(root).worktrees("")),
        Effect.orElseSucceed(() => worktrees),
      ),
    ]).map(transcriptDirName);

    for (const claudeDir of Arr.dedupe(claudeDirs)) {
      const projects = `${claudeDir}/projects`;

      if (!(yield* fs.exists(projects))) {
        continue;
      }

      for (const name of yield* fs.readDirectory(projects)) {
        if (prefixes.some((prefix) => name.startsWith(prefix))) {
          yield* fs.copy(`${projects}/${name}`, `${dir}/transcripts/${name}`, { overwrite: true });
        }
      }
    }
  }).pipe(
    Effect.catch((error) => Console.error(`could not keep the logs in ${dir}: ${String(error)}`)),
  );

const describeEnding = (ending: CiRunEnding) => {
  switch (ending.kind) {
    case "ended":
      return `${ending.status}: ${ending.summary}`;
    case "parked":
      return "parked: the run waits on a signal; the job ends here, and the event that settles the wait starts the next one";
    case "elsewhere":
      return ending.why;
    case "out-of-time":
      return "stopped before the job's time limit: the claim is let go and the phase left as it was, for the next job to repeat";
  }
};

// One item on one runner, to the next phase boundary. Fails only for a run
// that failed or ran out of the job's time, so the workflow keeps its logs.
export const runInCi = <R>(options: CiRunOptions, config: CiRunConfigAccess<R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const variables = (yield* HostEnvironment).variables;
    const paths = homePaths(home.root);

    const refused = refusalOf(variables, yield* fs.exists(paths.state));

    if (Option.isSome(refused)) {
      return yield* new ConfigError({ message: refused.value });
    }

    const stopAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.stopAfter);
    yield* prepareHome(options);

    const { enrolled, machine } = yield* config(options.repo);
    const opened = yield* openRepo(machine, enrolled, options.fromCheckout);
    const flow = Option.fromUndefinedOr(opened.flows.get(options.flow));

    if (Option.isNone(flow)) {
      return yield* new ConfigError({
        message: `${opened.repo.settings.name} has no flow named ${options.flow}`,
      });
    }

    // The job renews the claim itself, on a lease short enough that a killed
    // job's runs out before long.
    const repo: EffectiveRepo = {
      ...opened.repo,
      leases: { ...opened.repo.leases, ttl: options.leaseTtl, parkedTtl: options.leaseTtl },
    };

    const handle = flowHandle(repo, options.flow, flow.value, Option.none());
    yield* acquireLock(paths.engineLock, `ci run ${options.flow} ${options.item}`);
    const persona = yield* personaOf(repo, options.persona);
    const contexts = yield* buildPersonaContexts(repo, machine);

    const context = yield* yield* Effect.fromOption(servicesFrom(contexts)(persona)).pipe(
      Effect.orDie,
    );

    const claudeDirs = [
      `${home.user}/.claude`,
      ...Option.toArray(Record.get(variables, "CLAUDE_CONFIG_DIR")),
      ...machine.accounts.flatMap((account) => Option.toArray(account.configDir)),
    ];

    let started = Option.none<RunId>();

    const program = Effect.gen(function* () {
      const holder = yield* withRepo(context, Claims.liveHolder(options.item)).pipe(
        Effect.mapError((error) => new ConfigError({ message: error.message })),
      );

      if (Option.isSome(holder)) {
        return {
          kind: "elsewhere",
          why: `${holder.value.persona}'s run ${holder.value.runId} of ${holder.value.flow} holds ${options.item}: ${GOT_THERE_FIRST}`,
        } satisfies CiRunEnding;
      }

      const items = yield* withRepo(context, triggerOf(handle.flow)).pipe(
        Effect.mapError((error) => new ConfigError({ message: String(error) })),
      );

      const item = stillReported(items, options.item);

      if (Option.isNone(item)) {
        return {
          kind: "elsewhere",
          why: `the trigger no longer reports ${options.item} to start: its phase moved since the plan, so ${GOT_THERE_FIRST}`,
        } satisfies CiRunEnding;
      }

      const { run } = yield* (yield* RunFlowsCommands).StartFlowRunCommand({
        flow: refOf(handle, persona),
        item: item.value,
      });

      if (Option.isNone(run)) {
        return {
          kind: "elsewhere",
          why: `nothing started for ${options.item}: ${GOT_THERE_FIRST}`,
        } satisfies CiRunEnding;
      }

      started = Option.some(run.value.id);
      yield* Console.log(`started ${run.value.id} (${runLabel(run.value)}) for ${options.item}`);

      return yield* followToBoundary(run.value.id, options, stopAt);
    });

    // Whatever ends the job, its work is pushed, a claim it still holds let
    // go, and its logs kept: the next job repeats the phase from its start.
    const wrapUp = (exit: Exit.Exit<CiRunEnding, unknown>) =>
      Effect.gen(function* () {
        for (const runId of Option.toArray(started)) {
          const ended = Exit.isSuccess(exit) && exit.value.kind === "ended";
          yield* pushWork(repo, context, `chernabog ci run ${runId} stopped`).pipe(
            Effect.catch((error) => Console.error(`could not push the work: ${String(error)}`)),
          );

          if (!ended) {
            yield* releaseClaims(runId, context);
          }
        }

        for (const dir of Option.toArray(options.logs)) {
          yield* keepLogs(started, dir, claudeDirs);
        }
      });

    const engine = yield* Layer.build(
      engineRuntime({
        registry: {
          handles: [handle],
          services: (_repo, one) => servicesFrom(contexts)(one),
        },
        flows: [flowLayer(handle, servicesFrom(contexts))],
        engine: EngineLive,
      }),
    );

    const ending = yield* Effect.provideContext(
      program.pipe(Effect.onExit((exit) => wrapUp(exit))),
      engine,
    );

    yield* Console.log(describeEnding(ending));

    if (ending.kind === "out-of-time" || (ending.kind === "ended" && ending.status === "failed")) {
      return yield* new ConfigError({ message: describeEnding(ending) });
    }

    return ending;
  }).pipe(Effect.scoped);
