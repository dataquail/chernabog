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
//
// On a machine it is a spoke (ADR 23, #658): the hub has recorded the run and
// hands it over with `--run <id>` and the item (`--work-item-file`, or
// `--work-item`), and the spoke runs that one run, against the machine's home
// and a journal of the run's own, to its next phase boundary, then exits. It
// ends nothing in state.db and renews no lease: it reports how its run ended
// in its journal, and the hub, which renews its claim meanwhile, ends the run
// with that once it has exited (#659). It stops as on SIGTERM when its stdin
// closes, so it dies with the hub that holds the other end.

import { Claims, Git, triggerOf } from "@chernabog/core";
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
import { RunId, runLabel } from "../../kernel/run-id.id.ts";
import {
  buildPersonaContexts,
  CiPlan,
  EngineLive,
  type FlowHandle,
  flowHandle,
  flowLayer,
  type FlowRef,
  heldClaims,
  noHooks,
  openRepo,
  type RepoContext,
  RunFlowsCommands,
  RunFlowsQueries,
  runLogFile,
  RunLogLimit,
  type RunView,
  servicesFrom,
  SpokeEnding,
  SpokeEngineLive,
  type SpokeHandOver,
  SpokeHandOverJson,
  withRepo,
  withRepoReservedFor,
  type WorkItem,
} from "../../modules/runs/runs.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { type Environment, HostEnvironment } from "../../platform/environment.ts";
import { execOk } from "../../platform/exec.ts";
import { viewerAs, viewerLoginAs } from "../../platform/github-api.ts";
import { GH_TOKEN_CREDENTIAL_HELPER } from "../../platform/github-auth.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { acquireLock } from "../../platform/lock.ts";
import { killGroupOnStop, stopWhenStdinCloses } from "../../platform/shutdown.ts";
import { engineRuntime } from "../application-runtime.ts";
import { followOwnRun, startOwnRun } from "./own-hub.main.ts";
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
export const refusalOf = (variables: Environment, homeHasState: boolean): Option.Option<string> => {
  if (Record.has(variables, "ANTHROPIC_API_KEY")) {
    return Option.some(
      `ANTHROPIC_API_KEY is set (even empty), which claude bills per token over the subscription: unset it, and pass the subscription's token as ${OAUTH_TOKEN_ENV}`,
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
// job's every CI flow), with claude on the subscription token and under tmux.
// The account has no usage gate: a setup-token token can't read usage, and
// the gate refuses to try, so with one every plan would hold every flow back.
// checkAccount still runs.
//
// The flows act as the implicit persona, the job's GH_TOKEN, unless config
// names their Apps (#477): then each App's login is a persona whose token is
// GH_TOKEN, running the flows that act as it. GitHub won't say who an App's
// token or the workflow's is, so the login comes from config, never the token.
export const ciMachineConfig = (options: {
  readonly slug: string;
  readonly checkout: string;
  readonly flows: ReadonlyArray<string>;
  readonly apps: Readonly<Record<string, { readonly login: string }>>;
}) => {
  const enabled = (flows: ReadonlyArray<string>) =>
    Object.fromEntries(flows.map((flow) => [flow, {}]));

  const loginOf = (flow: string) => Option.map(Record.get(options.apps, flow), (app) => app.login);
  const logins = Arr.dedupe(options.flows.flatMap((flow) => Option.toArray(loginOf(flow))));

  const repo = {
    path: options.checkout,
    repo: options.slug,
    name: options.slug.split("/").at(-1) ?? options.slug,
    account: "ci",
  };

  const base = {
    accounts: { ci: { oauthTokenEnv: OAUTH_TOKEN_ENV, usageGate: "none" } },
    launcher: "tmux",
  };

  if (logins.length === 0) {
    return { ...base, repos: [{ ...repo, flows: enabled(options.flows) }] };
  }

  return {
    ...base,
    github: Object.fromEntries(logins.map((login) => [login, { token: { env: "GH_TOKEN" } }])),
    repos: [
      {
        ...repo,
        personas: Object.fromEntries(
          logins.map((login) => [
            login,
            {
              flows: enabled(options.flows.filter((flow) => Option.contains(loginOf(flow), login))),
            },
          ]),
        ),
      },
    ],
  };
};

// What a fresh runner's git needs, as global config: a credential helper that
// answers github.com with the job's GH_TOKEN, since the checkout keeps no
// credential (persist-credentials: false) and the implicit persona's git is
// whatever the machine's is; and an identity, the persona's own, so the agent's
// commits and the job's own are attributed to it on GitHub.
export const runnerGitConfig = (viewer: { readonly login: string; readonly id: number }) =>
  [
    ["credential.https://github.com.helper", GH_TOKEN_CREDENTIAL_HELPER],
    ["user.name", viewer.login],
    ["user.email", `${viewer.id}+${viewer.login}@users.noreply.github.com`],
  ] as const;

// The file a runner's global git config is written to: GIT_CONFIG_GLOBAL when
// the job names one, else ~/.gitconfig, never left to `git config --global`.
// That falls back to $XDG_CONFIG_HOME/git/config when ~/.gitconfig is missing,
// which a runner never has but a person's machine may: a job started there
// with a HOME of its own would rewrite the person's identity and credentials.
export const runnerGitConfigFile = (variables: Environment, user: string) =>
  Record.get(variables, "GIT_CONFIG_GLOBAL").pipe(
    Option.filter((path) => path.length > 0),
    Option.getOrElse(() => `${user}/.gitconfig`),
  );

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

// How the command reads the Apps a repo's CI flows act as, from its .chernabog/.
export type CiAppsAccess = (
  configDir: string,
) => Effect.Effect<
  { readonly apps: Readonly<Record<string, { readonly login: string }>> },
  ConfigError,
  FileSystem.FileSystem
>;

export type CiRunOptions = {
  readonly repo: string;
  readonly flow: string;
  // The login the run acts as; none for the repo's implicit persona, as a
  // hub hands over a run that persona's flow started.
  readonly persona: Option.Option<string>;
  readonly item: string;
  readonly logs: Option.Option<string>;
  readonly leaseTtl: Duration.Duration;
  readonly stopAfter: Duration.Duration;
  readonly fromCheckout: boolean;
  // The .chernabog/ tree to read, as its snapshot: a hub's spoke runs the tree
  // its hub trusted and loaded, never whatever the default branch has now.
  // None for the default branch's, or the working copy's.
  readonly tree?: Option.Option<string>;
  // The workflow run the job is part of (GITHUB_RUN_ID), whose plan job
  // reserved the item for it (#519); none outside Actions.
  readonly workflowRun: Option.Option<string>;
  // The hub's hand-over, which makes this a spoke on a machine: the run it
  // recorded, as it recorded it, and the item, as JSON inline or in a file.
  // None in a CI job.
  readonly run: Option.Option<string>;
  readonly handOver: Option.Option<string>;
  readonly handOverFile: Option.Option<string>;
  // A spoke's run-log bound, in bytes, which its hub passes; none for none.
  // Its telemetry bound is read where its telemetry is set up, from the
  // command line (`--telemetry-limit`, telemetryOfArgs).
  readonly runLogLimit?: Option.Option<number>;
};

// The run a hub recorded and handed to this spoke, with the item it is for.
export type HandedOver = SpokeHandOver;

// The hub's hand-over, from its JSON as given: none for a CI job, which is
// given neither. Refused when only half of it is given, or when the run or
// the item isn't the one `--run` or `--item` names.
export const handedOverFrom = (
  options: Pick<CiRunOptions, "run" | "item">,
  handOverJson: Option.Option<string>,
): Effect.Effect<Option.Option<HandedOver>, ConfigError> => {
  if (Option.isNone(options.run)) {
    return Option.match(handOverJson, {
      onNone: () => Effect.succeedNone,
      onSome: () =>
        Effect.fail(
          new ConfigError({
            message: "--hand-over and --hand-over-file are a hub's hand-over: give --run with them",
          }),
        ),
    });
  }

  const runId = RunId.make(options.run.value);

  return Option.match(handOverJson, {
    onNone: () =>
      Effect.fail(
        new ConfigError({
          message: `--run ${runId} needs the hub's hand-over: --hand-over-file, or --hand-over`,
        }),
      ),
    onSome: (text) =>
      Schema.decodeEffect(SpokeHandOverJson)(text).pipe(
        Effect.mapError(
          (issue) =>
            new ConfigError({ message: `the hand-over of ${runId} isn't one: ${issue.message}` }),
        ),
        Effect.filterOrFail(
          (handed) => handed.run.id === runId,
          (handed) =>
            new ConfigError({
              message: `--run ${runId} isn't the run handed over, ${handed.run.id}`,
            }),
        ),
        Effect.filterOrFail(
          (handed) => handed.item.key === options.item,
          (handed) =>
            new ConfigError({
              message: `--item ${options.item} isn't the item handed over with ${runId}, ${handed.item.key}`,
            }),
        ),
        Effect.asSome,
      ),
  });
};

// The hand-over's JSON as the hub gave it: inline, or in a file, never both.
const handOverJsonOf = (options: CiRunOptions) =>
  Effect.gen(function* () {
    if (Option.isSome(options.handOver) && Option.isSome(options.handOverFile)) {
      return yield* new ConfigError({
        message: "give the hand-over once: --hand-over or --hand-over-file",
      });
    }

    for (const path of Option.toArray(options.handOverFile)) {
      return Option.some(
        yield* (yield* FileSystem.FileSystem)
          .readFileString(path)
          .pipe(
            Effect.mapError(
              (error) => new ConfigError({ message: `reading the hand-over: ${error.message}` }),
            ),
          ),
      );
    }

    return options.handOver;
  });

const JsonText = Schema.fromJsonString(Schema.Json);

export const writeJson = (path: string, value: Schema.Json) =>
  Effect.gen(function* () {
    const text = yield* Schema.encodeEffect(JsonText)(value).pipe(Effect.orDie);
    yield* (yield* FileSystem.FileSystem).writeFileString(path, `${text}\n`);
  });

// The persona a CI flow's job acts as: the flow's App, by its login, when
// config names one; else the implicit persona, the job's GH_TOKEN.
export const ciPersonaOf = (
  apps: Readonly<Record<string, { readonly login: string }>>,
  flow: string,
): Persona => Option.map(Record.get(apps, flow), (app) => app.login);

// The home's machine config, written from the job's environment when the
// workflow left none; and on a runner, ~/.claude.json, seeded when it has
// none, and git's credential and identity (runnerGitConfig), the identity of
// the persona the job acts as.
const prepareHome = (options: CiRunOptions, ciOf: CiAppsAccess) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const variables = (yield* HostEnvironment).variables;
    const paths = homePaths(home.root);

    const checkout = Option.getOrElse(Record.get(variables, "GITHUB_WORKSPACE"), () =>
      process.cwd(),
    );

    yield* fs.makeDirectory(home.root, { recursive: true });

    const { apps } = yield* ciOf(`${checkout}/.chernabog`);

    const persona = ciPersonaOf(apps, options.flow);

    if (!(yield* fs.exists(paths.machineConfig))) {
      if (!Record.has(variables, OAUTH_TOKEN_ENV)) {
        return yield* new ConfigError({
          message: `${OAUTH_TOKEN_ENV} isn't set: claude needs the subscription's token, from claude setup-token`,
        });
      }

      const slug = Option.getOrElse(Record.get(variables, "GITHUB_REPOSITORY"), () => options.repo);
      yield* writeJson(
        paths.machineConfig,
        ciMachineConfig({ slug, checkout, flows: [options.flow], apps }),
      );
    }

    const claudeJson = `${home.user}/.claude.json`;

    if (Record.get(variables, "GITHUB_ACTIONS").pipe(Option.contains("true"))) {
      if (!(yield* fs.exists(claudeJson))) {
        yield* writeJson(claudeJson, claudeSeed([checkout, `${home.root}/worktrees`]));
      }

      // The helper answers with GH_TOKEN alone, which the workflow sets; a job
      // with only GITHUB_TOKEN would get an identity but fail at its first push.
      const ghToken = Record.get(variables, "GH_TOKEN");

      if (!Option.exists(ghToken, (token) => token.length > 0)) {
        return yield* new ConfigError({
          message:
            "GH_TOKEN isn't set: the run's git answers github.com with it (the workflow sets it from CHERNABOG_TOKEN)",
        });
      }

      const viewer = yield* viewerAs(persona).pipe(
        Effect.mapError(
          (error) => new ConfigError({ message: `who the job acts as: ${error.message}` }),
        ),
      );

      const gitConfig = runnerGitConfigFile(variables, home.user);

      for (const [key, value] of runnerGitConfig(viewer)) {
        yield* execOk("git", ["config", "--file", gitConfig, key, value]).pipe(
          Effect.mapError(
            (error) => new ConfigError({ message: `setting git's ${key}: ${error.message}` }),
          ),
        );
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
const personaOf = (repo: EffectiveRepo, asked: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(asked)) {
      if (repo.personas.some((own) => Option.isNone(own.persona))) {
        return IMPLICIT;
      }

      return yield* new ConfigError({
        message: `${repo.settings.name} has no implicit persona here: name the login with --persona`,
      });
    }

    const login = asked.value;

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

// The repo as a CI job runs it: every persona's settings say so (ciJob), so
// a flow that can resume from its record parks where it would poll, and the
// job ends there rather than billing the wait.
export const asCiJob = (repo: EffectiveRepo): EffectiveRepo => ({
  ...repo,
  settings: { ...repo.settings, ciJob: true },
  personas: Arr.map(repo.personas, (own) => ({
    ...own,
    settings: { ...own.settings, ciJob: true },
  })),
});

// Follows a job's run to its boundary: it ends, parks on a signal, loses its
// claim or runs out of the job's time, renewing its claim's short lease as it
// goes. The job is the run's own hub (ADR 23, decision 9): the run executes
// here in a journal of its own, which the job folds into its state.db.
const followToBoundary = (
  run: RunView,
  parked: ReadonlySet<RunId>,
  leaseTtl: Duration.Duration,
  stopAt: number,
) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(run.id));
    const renewEvery = Duration.toMillis(leaseTtl) / 3;
    let renewedAt = yield* Clock.currentTimeMillis;

    // Out of the job's time, or its claim taken: the job stops there.
    const stop = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (now >= stopAt) {
        return Option.some<CiRunEnding>({ kind: "out-of-time" });
      }

      if (now - renewedAt < renewEvery) {
        return Option.none<CiRunEnding>();
      }

      renewedAt = now;

      const leases = yield* (yield* RunFlowsCommands).CheckRunLeasesCommand({
        runId: run.id,
        renew: Option.some(leaseTtl),
      });

      if (Predicate.isTagged(leases, "Lost")) {
        return Option.some<CiRunEnding>({
          kind: "elsewhere",
          why: `${leases.reason}: ${GOT_THERE_FIRST}`,
        });
      }

      return Option.none<CiRunEnding>();
    });

    const boundary = yield* followOwnRun(run, parked, stop, tail);

    switch (boundary.kind) {
      case "ended":
        return {
          kind: "ended",
          status: boundary.status,
          summary: boundary.summary,
        } satisfies CiRunEnding;
      case "parked":
        return { kind: "parked" } satisfies CiRunEnding;
      case "stopped":
        return boundary.stop;
    }
  });

// Lets go of the claims a run holds, which a run that ended has let go
// already: those its records say it holds (heldClaims), which a spoke reads
// from its own journal.
const releaseClaims = (runId: RunId, context: RepoContext) =>
  Effect.gen(function* () {
    for (const claim of yield* heldClaims(runId)) {
      const released = yield* withRepo(context, Claims.releaseFor(claim.item, claim.runId)).pipe(
        Effect.orElseSucceed(() => false),
      );

      if (released) {
        yield* Console.log(`let go of the claim on ${claim.item}`);
      }
    }
  });

// Commits what the agent left uncommitted in each of the job's worktrees and
// pushes the branch it's on, as the persona, when that adds to what GitHub
// has: the next job repeats the phase from its start, and finds the work on
// the branch. A checkout on no branch, such as a review's, has nothing of its
// own to push, and a branch GitHub no longer has is never made again.
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

    // Only a branch GitHub still has: one the run's end deleted (a claim
    // branch it never pushed to), or a merge did, stays deleted.
    const remote = `refs/remotes/origin/${branch.value}`;

    const fetched = yield* git
      .run(["fetch", "-q", "origin", `+refs/heads/${branch.value}:${remote}`], path)
      .pipe(Effect.option);

    if (Option.isNone(fetched)) {
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

    const ahead = Number((yield* git.run(["rev-list", "--count", `${remote}..HEAD`], path)).trim());

    if (ahead === 0) {
      return Option.none<string>();
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

// Why a spoke's run ended at its park, for its summary, as the daemon says it.
const PARKED_REASON =
  "it waits on a person or another system: its record carries the wait, and a later run takes it up";

// What a spoke reports as its run's ending, for the hub to end the run with
// once the spoke has exited (ADR 23, decision 2): how its workflow ended, or
// at its park, or past its time. None for a spoke stopped by a signal or its
// stdin closing, whose run the hub that ends it ends, or the next hub reaps
// (ADR 23, decision 7).
export const spokeEndingOf = (exit: Exit.Exit<CiRunEnding, unknown>) => {
  if (Exit.isFailure(exit)) {
    return Option.none<SpokeEnding>();
  }

  switch (exit.value.kind) {
    case "ended":
      return Schema.decodeUnknownOption(SpokeEnding)({
        status: exit.value.status,
        summary: exit.value.summary,
      });
    case "parked":
      return Option.some<SpokeEnding>({ status: "ended-at-park", summary: PARKED_REASON });
    case "out-of-time":
      return Option.some<SpokeEnding>({ status: "failed", summary: describeEnding(exit.value) });
    case "elsewhere":
      return Option.some<SpokeEnding>({ status: "lost", summary: exit.value.why });
  }
};

// Writes the spoke's ending into its run's journal, its last report; a
// spoke that can't leaves its run to end as one that said nothing.
const reportEnding = (runId: RunId, ending: SpokeEnding) =>
  RunFlowsCommands.use((runs) => runs.ReportRunEndedCommand({ runId, ending })).pipe(
    Effect.flatMap(() => Console.log(`reported ${runId} as ${ending.status}`)),
    Effect.catchCause((cause) =>
      Console.error(`could not report how ${runId} ended: ${String(cause)}`),
    ),
  );

// Follows a spoke's run until its workflow ends, it parks or the spoke runs
// out of time. It ends nothing in state.db and renews no lease: the hub
// does both (ADR 23, decisions 2 and 6). Its park is what the engine told
// this process (`parked`), once the run's wait was recorded, so the spoke
// ends at its phase boundary: no run sleeps inside a process, and the run
// that takes the item up starts from its record in a spoke of its own.
const followSpoke = (
  over: HandedOver,
  executionId: string,
  flow: FlowRef,
  stopAt: number,
  parked: ReadonlySet<RunId>,
) =>
  Effect.gen(function* (): Effect.fn.Return<CiRunEnding, never, RunFlowsQueries> {
    const flows = yield* RunFlowsQueries;

    for (;;) {
      const polled = yield* flows.PollExecutionQuery({ runId: over.run.id, executionId, flow });

      for (const ended of Option.toArray(polled.ended)) {
        return { kind: "ended", status: ended.status, summary: ended.summary };
      }

      if (parked.has(over.run.id)) {
        return { kind: "parked" } satisfies CiRunEnding;
      }

      if ((yield* Clock.currentTimeMillis) >= stopAt) {
        return { kind: "out-of-time" } satisfies CiRunEnding;
      }

      yield* Effect.sleep("1 second");
    }
  });

// A spoke's run: the one the hub recorded and attached, executed here in a
// journal of its own for the item it handed over, without asking the trigger
// again (#656).
const spokeProgram = (
  over: HandedOver,
  flow: FlowRef,
  stopAt: number,
  parked: ReadonlySet<RunId>,
  onStarted: (runId: RunId) => void,
) =>
  Effect.gen(function* () {
    const run = yield* (yield* RunFlowsCommands)
      .ExecuteRunCommand({ run: over.run, item: over.item })
      .pipe(
        Effect.mapError(
          (error) => new ConfigError({ message: `executing ${over.run.id}: ${error.message}` }),
        ),
      );

    onStarted(run.id);
    yield* Console.log(`started ${run.id} (${runLabel(run)}) for ${over.item.key}`);

    // The hub attached the run's execution when it recorded the run.
    const executionId = yield* Effect.fromOption(run.executionId).pipe(
      Effect.mapError(
        () => new ConfigError({ message: `${run.id} has no execution: a hub records one with it` }),
      ),
    );

    return yield* followSpoke(over, executionId, flow, stopAt, parked);
  });

// The engine a run executes in: a spoke's journal, with its records there
// for the hub to fold (ADR 23, decision 3), or a job's, which is its own hub
// and records into its own state.db.
const engineOf = (
  handedOver: Option.Option<SpokeHandOver>,
): Layer.Layer<
  Layer.Success<typeof EngineLive>,
  Layer.Error<typeof EngineLive>,
  Layer.Services<typeof EngineLive>
> =>
  Option.match(handedOver, {
    onNone: () => EngineLive,
    onSome: SpokeEngineLive,
  });

// One item on one runner, to the next phase boundary. Fails only for a run
// that failed or ran out of the job's time, so the workflow keeps its logs.
// Handed a run (`--run`), it is a spoke on a machine instead: the run the hub
// recorded, against the machine's home.
export const runInCi = <R>(
  options: CiRunOptions,
  config: CiRunConfigAccess<R>,
  ciOf: CiAppsAccess,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const variables = (yield* HostEnvironment).variables;
    const paths = homePaths(home.root);

    const handedOver = yield* handedOverFrom(options, yield* handOverJsonOf(options));
    const spoke = Option.isSome(handedOver);

    // A spoke runs in the machine's own home, which holds its state.db.
    const refused = refusalOf(variables, !spoke && (yield* fs.exists(paths.state)));

    if (Option.isSome(refused)) {
      return yield* new ConfigError({ message: refused.value });
    }

    const stopAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.stopAfter);

    if (spoke) {
      yield* killGroupOnStop();
      yield* stopWhenStdinCloses();
    } else {
      yield* prepareHome(options, ciOf);
    }

    const { enrolled, machine } = yield* config(options.repo);
    const tree = options.tree ?? Option.none();

    if (options.fromCheckout && Option.isSome(tree)) {
      return yield* new ConfigError({
        message: "read .chernabog/ from one place: --from-checkout or --tree",
      });
    }

    const opened = yield* openRepo(machine, enrolled, options.fromCheckout, new Map(), tree);
    const flow = Option.fromUndefinedOr(opened.flows.get(options.flow));

    if (Option.isNone(flow)) {
      return yield* new ConfigError({
        message: `${opened.repo.settings.name} has no flow named ${options.flow}`,
      });
    }

    // The plan job's reservation of the item, which the run's claim replaces.
    const claim = CiPlan.claimName(options.item);

    const reservation = Option.map(
      Option.filter(options.workflowRun, () => !spoke),
      (workflowRun) => CiPlan.reservationFor(workflowRun, claim),
    );

    // A spoke runs the repo as the machine does. A job renews the claim
    // itself, on a lease short enough that a killed job's runs out before
    // long, and parks where a flow can resume rather than bill the wait.
    const repo: EffectiveRepo = Option.match(handedOver, {
      onSome: () => opened.repo,
      onNone: () => ({
        ...asCiJob(opened.repo),
        leases: {
          ...opened.repo.leases,
          ttl: options.leaseTtl,
          ...Option.match(reservation, {
            onNone: () => ({}),
            onSome: (takesOver) => ({ takesOver }),
          }),
        },
      }),
    });

    const handle = flowHandle(repo, options.flow, flow.value, Option.none());

    // A job's home is its own, so its engine is the only one there. A spoke
    // shares the machine's home with the hub and its other spokes, and takes
    // no lock: its journal is its run's alone (ADR 23, decision 3).
    if (!spoke) {
      yield* acquireLock(paths.engineLock, `ci run ${options.flow} ${options.item}`);
    }

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

    // The runs this process's engine parked, as it tells them.
    const parked = new Set<RunId>();

    const jobProgram = Effect.gen(function* () {
      // The plan job's reservation is this job's to take over, not another run's.
      const holder = Option.filter(
        yield* withRepo(context, Claims.liveHolder(claim)).pipe(
          Effect.mapError((error) => new ConfigError({ message: error.message })),
        ),
        (found) => !Option.contains(reservation, found.runId),
      );

      if (Option.isSome(holder)) {
        return {
          kind: "elsewhere",
          why: `${holder.value.persona}'s run ${holder.value.runId} of ${holder.value.flow} holds ${options.item}: ${GOT_THERE_FIRST}`,
        } satisfies CiRunEnding;
      }

      const items = yield* withRepoReservedFor(reservation)(context, triggerOf(handle.flow)).pipe(
        Effect.mapError((error) => new ConfigError({ message: String(error) })),
      );

      const item = stillReported(items, options.item);

      if (Option.isNone(item)) {
        return {
          kind: "elsewhere",
          why: `the trigger no longer reports ${options.item} to start: its phase moved since the plan, so ${GOT_THERE_FIRST}`,
        } satisfies CiRunEnding;
      }

      const run = yield* startOwnRun(refOf(handle, persona), item.value);

      if (Option.isNone(run)) {
        return {
          kind: "elsewhere",
          why: `nothing started for ${options.item}: ${GOT_THERE_FIRST}`,
        } satisfies CiRunEnding;
      }

      started = Option.some(run.value.id);
      yield* Console.log(`started ${run.value.id} (${runLabel(run.value)}) for ${options.item}`);

      return yield* followToBoundary(run.value, parked, repo.leases.ttl, stopAt);
    });

    const program: Effect.Effect<
      CiRunEnding,
      ConfigError,
      Effect.Services<typeof jobProgram> | RunFlowsQueries
    > = Option.match(handedOver, {
      onSome: (over) =>
        spokeProgram(over, refOf(handle, persona), stopAt, parked, (runId) => {
          started = Option.some(runId);
        }),
      onNone: () => jobProgram,
    });

    // Whatever ends the job, its work is pushed, a claim it still holds let
    // go, and its logs kept: the next job repeats the phase from its start.
    const wrapUp = (exit: Exit.Exit<CiRunEnding, unknown>) =>
      Effect.gen(function* () {
        // A run that ended has no phase for a next job to repeat, and the
        // engine has cleaned up after it: its branches are left as they are.
        const ended = Exit.isSuccess(exit) && exit.value.kind === "ended";

        for (const runId of Option.toArray(Option.filter(started, () => !ended))) {
          yield* pushWork(repo, context, `chernabog ci run ${runId} stopped`).pipe(
            Effect.catch((error) => Console.error(`could not push the work: ${String(error)}`)),
          );
          yield* releaseClaims(runId, context);
        }

        // A spoke's last report: how its run ended, which the hub ends the
        // run with once the spoke has exited.
        for (const runId of Option.toArray(Option.filter(started, () => spoke))) {
          for (const ending of Option.toArray(spokeEndingOf(exit))) {
            yield* reportEnding(runId, ending);
          }
        }

        // A reservation the run never took over, as when nothing started, is
        // let go, so the item waits for no lease; one it took over is gone.
        for (const reserved of Option.toArray(reservation)) {
          const released = yield* withRepo(context, Claims.releaseFor(claim, reserved)).pipe(
            Effect.orElseSucceed(() => false),
          );

          if (released) {
            yield* Console.log(`let go of the plan's reservation of ${claim}`);
          }
        }

        for (const dir of Option.toArray(options.logs)) {
          yield* keepLogs(started, dir, claudeDirs);
        }
      });

    const runLogLimit = options.runLogLimit ?? Option.none();

    const engine = yield* Layer.build(
      engineRuntime({
        registry: {
          handles: [handle],
          services: (_repo, one) => servicesFrom(contexts)(one),
        },
        flows: [
          flowLayer(handle, servicesFrom(contexts), noHooks, (runId) =>
            Effect.sync(() => {
              parked.add(runId);
            }),
          ),
        ],
        engine: engineOf(handedOver),
      }),
    ).pipe(Effect.provideService(RunLogLimit, runLogLimit));

    const ending = yield* Effect.provideContext(
      program.pipe(
        Effect.onExit((exit) => wrapUp(exit)),
        Effect.provideService(RunLogLimit, runLogLimit),
      ),
      engine,
    );

    yield* Console.log(describeEnding(ending));

    if (ending.kind === "out-of-time" || (ending.kind === "ended" && ending.status === "failed")) {
      return yield* new ConfigError({ message: describeEnding(ending) });
    }

    return ending;
  }).pipe(Effect.scoped);
