// The config layers. The team decides what work gets done and how
// (.chernabog/config.yaml, committed); each person decides, in machine config
// (~/.config/chernabog/config.yaml), how much of their budget it spends and,
// for each repo they enroll, which flows run as each of their GitHub personas,
// when, and with which account. A repo's entry there is keyed by its slug, so
// its settings follow the repo rather than the folder. Later layers override
// earlier ones key by key, except that a repo can never raise machine limits,
// and a person's launcher must be one the repo allows.

import {
  type Account,
  DEFAULT_LABELS,
  type Flow,
  type LauncherCommands,
  type Limits,
  type RepoSettings,
  type ResolvedLauncher,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { asSuffix, IMPLICIT, type Persona, samePersona } from "./kernel/persona.value-object.ts";
import { EnrolledRepoRootOps } from "./modules/enrollment/domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { FlowSettings } from "./modules/enrollment/domain/enrolled-repo/flow-settings.value-object.ts";
import { type PersonaEntry } from "./modules/enrollment/domain/enrolled-repo/persona-choices.value-object.ts";
import {
  type EnrolledRepoEntry,
  EnrolledRepoEntry as EnrolledRepoSchema,
  toRoot as entryToRoot,
} from "./modules/enrollment/infrastructure/repositories/enrolled-repo.mapper.ts";
import { FLOW_TURNED_OFF } from "./modules/enrollment/use-cases/enrolled-repos.result.ts";
import { namesMe, type Routing } from "./modules/runs/domain/routing/routing.value-object.ts";
import { chooseSchedule } from "./modules/runs/domain/schedule/schedule.value-object.ts";
import type { AgentsConfig } from "./modules/runs/infrastructure/runtime/agents.ts";
import {
  BUILT_IN_LAUNCHERS,
  type LaunchersConfig,
} from "./modules/runs/infrastructure/runtime/launchers.ts";
import type { GateConfig } from "./modules/runs/infrastructure/runtime/usage-gate.ts";
import { writeFileAtomic } from "./platform/atomic-write.ts";
import { ConfigError } from "./platform/config-error.ts";
import { type Environment, HostEnvironment } from "./platform/environment.ts";
import { checkConfigVersion } from "./platform/flow-deps.ts";
import { expandHome, Home, homePaths } from "./platform/home.ts";
import { nodeBinFor } from "./platform/node-version.ts";

export type { Routing };

export { FLOW_TURNED_OFF };

const Strings = Schema.Array(Schema.String);

const DURATION = /^(\d+(?:\.\d+)?)\s*(millis?|seconds?|minutes?|hours?|days?|weeks?)$/;

const UNIT_MILLIS: Readonly<Record<string, number>> = {
  milli: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// "6 hours", "90 minutes": the durations config may name.
export const parseDuration = (text: string) =>
  Option.fromNullishOr(DURATION.exec(text.trim())).pipe(
    Option.flatMap((match) =>
      Option.map(Record.get(UNIT_MILLIS, match[2].replace(/s$/, "")), (millis) =>
        Duration.millis(Number(match[1]) * millis),
      ),
    ),
  );

const DurationText = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (text: string) =>
        Option.isSome(parseDuration(text)) || `"${text}" is not a duration, such as "6 hours"`,
    ),
  ),
);

// A YAML null turns the setting off.
const Nullable = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.OptionFromNullOr(schema));

// GitHub logins whose machines run a flow by default; anyone's, when left out.
const Runners = Schema.Array(Schema.String).annotate({
  description:
    "GitHub logins that run this by default: chernabog enroll offers it to them and not to others. Anyone's when unset. A person can still list the flow for themselves in machine config.",
});

const RepoFlowSettings = Schema.Struct({
  ...FlowSettings.fields,
  runners: Schema.optionalKey(Runners),
});

const LimitsFile = Schema.Struct({
  localGateRounds: Schema.optionalKey(Schema.Int),
  ciRounds: Schema.optionalKey(Schema.Int),
  reviewRounds: Schema.optionalKey(Schema.Int),
  staleAfter: Schema.optionalKey(DurationText),
  ciTimeout: Schema.optionalKey(DurationText),
});

const Board = Schema.Struct({
  projectNumber: Schema.Int,
  readyStatus: Schema.String,
  inProgressStatus: Schema.String,
});

const LabelsFile = Schema.Struct({
  eligible: Schema.optionalKey(Schema.String),
  inProgress: Schema.optionalKey(Schema.String),
  needsReview: Schema.optionalKey(Schema.String),
  changesRequested: Schema.optionalKey(Schema.String),
  approved: Schema.optionalKey(Schema.String),
  needsHuman: Schema.optionalKey(Schema.String),
  needsClarification: Schema.optionalKey(Schema.String),
  stale: Schema.optionalKey(Schema.String),
  ship: Schema.optionalKey(Schema.String),
  hybrid: Schema.optionalKey(Schema.String),
});

// Launcher commands run in a person's own terminal setup, so a repo can name launchers but never define one.
const MACHINE_ONLY =
  "launcher commands can only be defined in machine config (~/.config/chernabog/config.yaml)";

// No value is allowed, so editors flag the key too.
const MachineOnly = Schema.optionalKey(
  Schema.Never.annotate({ description: MACHINE_ONLY, message: MACHINE_ONLY }),
);

// .chernabog/config.yaml: what work gets done and how. Committed.
export const RepoConfigFile = Schema.Struct({
  baseBranch: Schema.optionalKey(Schema.String),
  install: Nullable(Schema.String),
  localGate: Schema.optionalKey(Strings),
  humanOnly: Schema.optionalKey(Strings),
  humanOnlyPaths: Schema.optionalKey(Strings),
  notes: Schema.optionalKey(Strings),
  board: Nullable(Board),
  reviewTrigger: Nullable(Schema.String),
  labels: Schema.optionalKey(LabelsFile),
  schedule: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  // The team's default launcher, and the launchers a person may choose; any, when left out.
  launcher: Schema.optionalKey(Schema.String),
  allowedLaunchers: Schema.optionalKey(Strings),
  launchers: MachineOnly,
  limits: Schema.optionalKey(LimitsFile),
  runners: Schema.optionalKey(Runners),
  reviewers: Schema.optionalKey(
    Strings.annotate({
      description:
        "The reviewer pool, by GitHub login: a pull request with green CI asks one of them at random to review it, never its author. Each needs write access, since the reviewer merges on the automated path (auto:ship).",
    }),
  ),
  flows: Schema.optionalKey(Schema.Record(Schema.String, RepoFlowSettings)),
});

export type RepoConfigFile = typeof RepoConfigFile.Type;

const AccountFile = Schema.Struct({
  configDir: Nullable(Schema.String),
  expectedEmail: Nullable(Schema.String),
  oauthTokenEnv: Nullable(Schema.String),
  usageGate: Schema.optionalKey(Schema.Literal("none")),
  agent: Schema.optionalKey(Schema.String),
});

export const AgentFile = Schema.Struct({
  // Extra arguments for a built-in adapter, such as ["--auto"] for opencode.
  args: Schema.optionalKey(Strings),
  // An agent of your own: command templates with {prompt}, {promptFile}, {sessionId} and {cwd}.
  start: Schema.optionalKey(Strings),
  resume: Schema.optionalKey(Strings),
});

// A launcher of your own: command templates with {command}, {cwd}, {title} and {handle}.
export const LauncherFile = Schema.Struct({
  start: Strings,
  close: Strings,
  alive: Schema.optionalKey(Strings),
  attach: Schema.optionalKey(Strings),
});

// A repo's entry in machine config, as stored.
export const EnrolledRepo = EnrolledRepoSchema;

export type EnrolledRepo = EnrolledRepoEntry;

// An entry as the enrollment domain sees it. These edits never touch whether
// the repo is paused, which machine config doesn't keep.
const toRoot = (entry: EnrolledRepo) => entryToRoot(entry, false);

export const UsageGateFile = Schema.Struct({
  targetEndUsage: Schema.Finite,
  taskCostEstimate: Schema.Finite,
  fiveHourCeiling: Schema.Finite,
  humanRatePerHour: Schema.Finite,
});

// A GitHub persona on this machine. Its token always comes from
// `gh auth token --user <login>` and is never written here.
const GitHubPersonaFile = Schema.Struct({});

// ~/.config/chernabog/config.yaml: budget and accounts, for this machine only.
export const MachineConfigFile = Schema.Struct({
  // GitHub personas by login. Without it, the one persona is whoever the
  // daemon is: GH_TOKEN, then GITHUB_TOKEN, then gh's active account.
  github: Schema.optionalKey(Schema.Record(Schema.String, GitHubPersonaFile)),
  accounts: Schema.optionalKey(Schema.Record(Schema.String, AccountFile)),
  usageGate: Schema.optionalKey(UsageGateFile),
  concurrency: Schema.optionalKey(Schema.Int),
  quietHours: Schema.optionalKey(Schema.String),
  humanOnly: Schema.optionalKey(Strings),
  agents: Schema.optionalKey(Schema.Record(Schema.String, AgentFile)),
  // Your launcher for every repo, and launchers of your own. Only here, never in a repo.
  launcher: Schema.optionalKey(Schema.String),
  launchers: Schema.optionalKey(Schema.Record(Schema.String, LauncherFile)),
  repos: Schema.optionalKey(Schema.Array(EnrolledRepoSchema)),
});

export type MachineConfigFile = typeof MachineConfigFile.Type;

export const DEFAULT_GATE: GateConfig = {
  targetEndUsage: 0.95,
  taskCostEstimate: 0.04,
  fiveHourCeiling: 0.4,
  humanRatePerHour: 0.005,
};

export const DEFAULT_LIMITS: Limits = {
  localGateRounds: 2,
  ciRounds: 3,
  reviewRounds: 1,
  staleAfter: Duration.hours(6),
  ciTimeout: Duration.hours(2),
};

// Each account belongs to one agent: claude unless it says otherwise.
export type MachineAccount = Account & { readonly agent: string };

export type MachineConfig = {
  // The logins under github:; none when it's left out.
  readonly github: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<MachineAccount>;
  readonly agents: AgentsConfig;
  readonly launcher: Option.Option<string>;
  readonly launchers: LaunchersConfig;
  readonly usageGate: GateConfig;
  readonly concurrency: number;
  readonly quietHours: Option.Option<string>;
  readonly humanOnly: ReadonlyArray<string>;
  readonly repos: ReadonlyArray<EnrolledRepo>;
};

// One enrolled repo as one persona runs it, with every layer merged.
export type PersonaRepo = {
  readonly persona: Persona;
  readonly settings: RepoSettings;
  readonly enabled: boolean;
  // The repo-wide default from each layer. The persona's beats every schedule
  // the team sets, a flow's own included; the team's is the last fallback.
  readonly schedule: { readonly own: Option.Option<string>; readonly repo: Option.Option<string> };
  readonly activeHours: Option.Option<string>;
  readonly flows: Readonly<Record<string, FlowSettings>>;
  // The flows this persona runs: the ones machine config lists for it.
  readonly chosen: ReadonlyArray<string>;
  // What the persona chose in machine config, its own keys over the repo
  // entry's, and the team's flow settings before them: what overrides what.
  readonly own: PersonaEntry;
  readonly teamFlows: Readonly<Record<string, FlowSettings>>;
};

// One enrolled repo: its settings as each persona that runs it sees them.
// `settings` is the first persona's, for what every persona shares (its name,
// path, labels and limits); account, agent and launcher are each persona's own.
export type EffectiveRepo = {
  readonly settings: RepoSettings;
  // The repo's personas, or only the implicit one.
  readonly personas: Arr.NonEmptyReadonlyArray<PersonaRepo>;
};

export const personaOf = (repo: EffectiveRepo, persona: Persona) =>
  Arr.findFirst(repo.personas, (candidate) => samePersona(candidate.persona, persona));

// Whether a login is one of a flow's runners. Logins are case-insensitive, as on GitHub.
export const isRunner = (runners: ReadonlyArray<string>, login: string) =>
  runners.some((runner) => runner.toLowerCase() === login.toLowerCase());

// Why the team doesn't have these logins run a flow with these runners, if it doesn't.
export const notARunner = (runners: ReadonlyArray<string>, logins: ReadonlyArray<string>) => {
  const who = Option.match(Option.liftPredicate(logins, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => "this machine's GitHub login is unknown",
    onSome: (found) => `this machine is ${found.join(", ")}`,
  });

  return Option.liftPredicate(
    `not a runner (runners: ${runners.join(", ")}; ${who})`,
    () => !logins.some((login) => isRunner(runners, login)),
  );
};

// Why the team has a flow off for these logins, if it does: its
// flows.<flow>.enabled, else its runners. What enrolling offers by default.
export const teamOff = (repo: RepoConfigFile, flow: string, logins: ReadonlyArray<string>) =>
  Option.orElse(
    Option.liftPredicate(FLOW_TURNED_OFF, () => repo.flows?.[flow]?.enabled === false),
    () =>
      Option.flatMap(
        Option.orElse(Option.fromUndefinedOr(repo.flows?.[flow]?.runners), () =>
          Option.fromUndefinedOr(repo.runners),
        ),
        (runners) => notARunner(runners, logins),
      ),
  );

// Whether the team names runners for any of these flows, so the defaults need this machine's login.
export const namesRunners = (repo: RepoConfigFile, flows: ReadonlyArray<string>) =>
  Option.isSome(Option.fromUndefinedOr(repo.runners)) ||
  flows.some((flow) => Option.isSome(Option.fromUndefinedOr(repo.flows?.[flow]?.runners)));

const listOf = (who: Option.Option<string | ReadonlyArray<string>>) =>
  Option.map(who, (found): ReadonlyArray<string> => Arr.ensure(found));

// Whose work items a flow starts as this persona; anyone's without a filter.
export const routingOf = (repo: PersonaRepo, flow: string): Routing => {
  const settings = Record.get(repo.flows, flow);

  return {
    assignee: Option.flatMap(settings, (found) =>
      listOf(Option.flatten(Option.fromUndefinedOr(found.assignee))),
    ),
    reviewRequested: Option.flatMap(settings, (found) =>
      listOf(Option.flatten(Option.fromUndefinedOr(found.reviewRequested))),
    ),
  };
};

// Whether the daemon must know this machine's GitHub login for the repo: for
// a flow the implicit persona runs that starts only work for @me. A named
// persona's login is its own.
export const needsLogin = (repo: EffectiveRepo) =>
  repo.personas.some(
    (own) =>
      Option.isNone(own.persona) &&
      own.chosen.some((flow) => {
        const routing = routingOf(own, flow);

        return namesMe(routing.assignee) || namesMe(routing.reviewRequested);
      }),
  );

// When a persona's flow ticks: the flow's own setting for the persona in
// machine config, then the persona's default, then the team's: the flow's
// setting in config.yaml, the flow module's, the repo's. `index` of `count`
// spreads the repos without one across the hour.
export const scheduleFor = (
  repo: PersonaRepo,
  flowName: string,
  flow: Flow,
  index: number,
  count: number,
) =>
  chooseSchedule(
    {
      flow: Option.flatMap(Record.get(repo.flows, flowName), (settings) =>
        Option.fromUndefinedOr(settings.schedule),
      ),
      persona: repo.schedule.own,
      module: Option.fromUndefinedOr(flow.schedule),
      repo: repo.schedule.repo,
    },
    index,
    count,
  );

// Why a persona doesn't run a flow, if it doesn't: machine config doesn't list
// it for the persona.
export const flowOff = (repo: PersonaRepo, flow: string): Option.Option<string> =>
  Option.liftPredicate(FLOW_TURNED_OFF, () => !repo.chosen.includes(flow));

// A YAML file decoded into a schema's type; an absent file is an empty one.
// `strict` refuses keys the schema doesn't name, rather than dropping them.
export const readYaml = <A, I>(schema: Schema.Codec<A, I>, file: string, strict = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failed = (message: string) => new ConfigError({ message: `${file}: ${message}` });
    // An absent or empty file sets nothing.
    let text = "{}";

    if (yield* fs.exists(file)) {
      text = yield* fs.readFileString(file);
    }

    if (text.trim().length === 0) {
      text = "{}";
    }

    const document = YAML.parseDocument(text);

    if (document.errors.length > 0) {
      return yield* failed(document.errors.map((error) => error.message).join("; "));
    }

    let onExcessProperty: "error" | "ignore" = "ignore";

    if (strict) {
      onExcessProperty = "error";
    }

    return yield* Schema.decodeUnknownEffect(schema)(document.toJS(), { onExcessProperty }).pipe(
      Effect.mapError((issue) => failed(issue.message)),
    );
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: `${file}: ${error.message}` })),
    ),
  );

export const machineConfigFile = Home.use((home) =>
  Effect.succeed(homePaths(home.root).machineConfig),
);

const fromAccountFile =
  (home: string) =>
  (entry: readonly [string, typeof AccountFile.Type]): MachineAccount => {
    const [name, account] = entry;

    return {
      name,
      configDir: Option.map(Option.flatten(Option.fromUndefinedOr(account.configDir)), (dir) =>
        expandHome(dir, home),
      ),
      expectedEmail: Option.flatten(Option.fromUndefinedOr(account.expectedEmail)),
      oauthTokenEnv: Option.flatten(Option.fromUndefinedOr(account.oauthTokenEnv)),
      usageGate: account.usageGate ?? "usage",
      agent: account.agent ?? "claude",
    };
  };

const launcherCommandsOf = (file: typeof LauncherFile.Type): LauncherCommands => ({
  start: file.start,
  close: file.close,
  alive: Option.fromUndefinedOr(file.alive),
  attach: Option.fromUndefinedOr(file.attach),
});

export const normalizeMachineConfig = (file: MachineConfigFile, home: string): MachineConfig => ({
  github: Object.keys(file.github ?? {}),
  accounts: Object.entries(file.accounts ?? { work: {} }).map(fromAccountFile(home)),
  agents: file.agents ?? {},
  launcher: Option.fromUndefinedOr(file.launcher),
  launchers: Record.map(file.launchers ?? {}, launcherCommandsOf),
  usageGate: file.usageGate ?? DEFAULT_GATE,
  concurrency: file.concurrency ?? 1,
  quietHours: Option.fromUndefinedOr(file.quietHours),
  humanOnly: file.humanOnly ?? [],
  repos: (file.repos ?? []).map((repo) => ({ ...repo, path: expandHome(repo.path, home) })),
});

export const loadMachineConfig = Effect.gen(function* () {
  const home = yield* Home;
  const file = yield* readYaml(MachineConfigFile, homePaths(home.root).machineConfig);

  return normalizeMachineConfig(file, home.user);
});

export const repoNameOf = (repo: EnrolledRepo) => EnrolledRepoRootOps.nameOf(toRoot(repo));

export const findEnrolled = (machine: MachineConfig, name: string) =>
  Effect.fromOption(
    Arr.findFirst(
      machine.repos,
      (repo) => repoNameOf(repo) === name || repo.repo === name || repo.path === name,
    ),
  ).pipe(
    Effect.mapError(() => {
      const enrolled = machine.repos.map(repoNameOf).join(", ");

      let known = "none";

      if (enrolled.length > 0) {
        known = enrolled;
      }

      return new ConfigError({
        message: `no enrolled repo named ${name} (enrolled: ${known}); run chernabog enroll in it`,
      });
    }),
  );

const mergeFlows = (
  layers: ReadonlyArray<Readonly<Record<string, FlowSettings>>>,
  machineConcurrency: number,
) => {
  const merged: Record<string, FlowSettings> = {};

  // Roles merge one by one, so a person can swap one role's adapter and keep the team's others.
  for (const layer of layers) {
    for (const [name, settings] of Object.entries(layer)) {
      const earlier = Option.fromUndefinedOr(merged[name]?.agents);
      const later = Option.fromUndefinedOr(settings.agents);
      merged[name] = { ...merged[name], ...settings };

      if (Option.isSome(earlier) && Option.isSome(later)) {
        merged[name] = { ...merged[name], agents: { ...earlier.value, ...later.value } };
      }
    }
  }

  // A repo can lower concurrency, never raise it past the machine's.
  return Record.map(merged, (settings) =>
    Option.match(Option.fromUndefinedOr(settings.concurrency), {
      onNone: () => settings,
      onSome: (concurrency) => ({
        ...settings,
        concurrency: Math.min(concurrency, machineConcurrency),
      }),
    }),
  );
};

const ownAccount = (account: MachineAccount): Account => ({
  name: account.name,
  configDir: account.configDir,
  expectedEmail: account.expectedEmail,
  oauthTokenEnv: account.oauthTokenEnv,
  usageGate: account.usageGate,
});

// The repo's own account for its agent; for any other agent, that agent's first account.
const accountsByAgent = (machine: MachineConfig, own: MachineAccount) => {
  const byAgent: Record<string, Account> = {};

  for (const candidate of machine.accounts) {
    if (!(candidate.agent in byAgent)) {
      byAgent[candidate.agent] = ownAccount(candidate);
    }
  }

  byAgent[own.agent] = ownAccount(own);

  return byAgent;
};

const limitsFrom = (file: RepoConfigFile["limits"]): Limits => ({
  localGateRounds: file?.localGateRounds ?? DEFAULT_LIMITS.localGateRounds,
  ciRounds: file?.ciRounds ?? DEFAULT_LIMITS.ciRounds,
  reviewRounds: file?.reviewRounds ?? DEFAULT_LIMITS.reviewRounds,
  staleAfter: Option.getOrElse(
    Option.flatMap(Option.fromUndefinedOr(file?.staleAfter), parseDuration),
    () => DEFAULT_LIMITS.staleAfter,
  ),
  ciTimeout: Option.getOrElse(
    Option.flatMap(Option.fromUndefinedOr(file?.ciTimeout), parseDuration),
    () => DEFAULT_LIMITS.ciTimeout,
  ),
});

// Unlike the agent, the launcher describes the person's own machine, so their
// choice beats the team's default: the repo's entry in machine config (or its
// persona's), then machine config's own, then the repo. The team limits it
// with allowedLaunchers, and a launcher outside that list fails the repo
// instead of quietly running under another one.
export const resolveLauncher = (
  machine: MachineConfig,
  repoName: string,
  files: { readonly repo: RepoConfigFile; readonly own: PersonaEntry },
) =>
  Effect.gen(function* () {
    const chosen = Arr.findFirst(
      [
        { from: "repo entry", name: Option.fromUndefinedOr(files.own.launcher) },
        { from: "machine config", name: machine.launcher },
        { from: "repo config", name: Option.fromUndefinedOr(files.repo.launcher) },
      ],
      (layer) => Option.isSome(layer.name),
    );

    const { from, name } = Option.getOrElse(
      Option.flatMap(chosen, (layer) =>
        Option.map(layer.name, (found) => ({ from: layer.from, name: found })),
      ),
      () => ({ from: "default", name: "headless" }),
    );

    // A custom launcher can't take a built-in's name.
    const custom = Option.filter(
      Record.get(machine.launchers, name),
      () => !BUILT_IN_LAUNCHERS.includes(name),
    );

    if (!BUILT_IN_LAUNCHERS.includes(name) && Option.isNone(custom)) {
      const known = [
        ...BUILT_IN_LAUNCHERS,
        ...Object.keys(machine.launchers).filter((own) => !BUILT_IN_LAUNCHERS.includes(own)),
      ];

      return yield* new ConfigError({
        message: `unknown launcher "${name}" (from ${from}); known launchers: ${known.join(", ")}`,
      });
    }

    const allowed = Option.fromUndefinedOr(files.repo.allowedLaunchers);

    if (Option.isSome(allowed) && !allowed.value.includes(name)) {
      return yield* new ConfigError({
        message: `launcher "${name}" (from ${from}) isn't allowed by ${repoName}'s config: allowedLaunchers is ${allowed.value.join(", ")}`,
      });
    }

    return { name, from, custom } satisfies ResolvedLauncher;
  });

// The personas that run a repo's flows. Without github:, only the implicit one.
// With it, the repo's personas, each one of github:'s logins, defaulting to the
// only login. Several logins and no choice is refused rather than guessed.
export const personasOf = (machine: MachineConfig, enrolled: EnrolledRepo) =>
  Effect.gen(function* () {
    const chosen = Option.map(Option.fromUndefinedOr(enrolled.personas), Object.keys);

    const failed = (message: string) =>
      new ConfigError({ message: `${enrolled.repo}: ${message}` });

    if (machine.github.length === 0) {
      if (Option.isSome(chosen)) {
        return yield* failed(
          "personas names GitHub logins, but machine config has no github: to list them",
        );
      }

      return Arr.of(IMPLICIT);
    }

    if (Option.isNone(chosen)) {
      if (machine.github.length === 1) {
        return Arr.of(Option.some(machine.github[0]));
      }

      return yield* failed(
        `machine config lists several GitHub personas (${machine.github.join(", ")}); choose this repo's with personas:`,
      );
    }

    const unknown = chosen.value.filter((login) => !machine.github.includes(login));

    if (unknown.length > 0) {
      return yield* failed(
        `personas ${unknown.join(", ")} not listed under github: (it has: ${machine.github.join(", ")})`,
      );
    }

    if (!Arr.isReadonlyArrayNonEmpty(chosen.value)) {
      return yield* failed("personas is empty; leave the repo out of machine config instead");
    }

    return Arr.map(chosen.value, (login): Persona => Option.some(login));
  });

// A persona's choices for a repo: its own entry's keys over the repo entry's.
export const choicesOf = (enrolled: EnrolledRepo, persona: Persona): PersonaEntry =>
  EnrolledRepoRootOps.choicesOf(toRoot(enrolled), persona);

const findAccount = (
  machine: MachineConfig,
  name: string,
  failed: (message: string) => ConfigError,
) =>
  Effect.fromOption(Arr.findFirst(machine.accounts, (candidate) => candidate.name === name)).pipe(
    Effect.mapError(() =>
      failed(
        `account "${name}" is not one of ${machine.accounts.map((known) => known.name).join(", ")}`,
      ),
    ),
  );

// The persona's other accounts, and each role's, by the agent they run, and
// each role's adapter. Accounts are chosen by agent, so each must run another
// agent than the persona's own account, and no two the same one.
const otherAccounts = (
  machine: MachineConfig,
  own: PersonaEntry,
  account: MachineAccount,
  failed: (message: string) => ConfigError,
) =>
  Effect.gen(function* () {
    const accounts: Record<string, Account> = {};
    const agents: Record<string, string> = {};

    for (const name of own.accounts ?? []) {
      const picked = yield* findAccount(machine, name, failed);

      if (picked.agent === account.agent) {
        return yield* failed(
          `accounts names ${picked.name}, a ${picked.agent} account like the persona's own (${account.name}); list only accounts of other agents`,
        );
      }

      if (picked.agent in accounts) {
        return yield* failed(`accounts names two ${picked.agent} accounts; list one per agent`);
      }

      accounts[picked.agent] = ownAccount(picked);
    }

    for (const [role, name] of Object.entries(own.roles ?? {})) {
      const picked = yield* findAccount(machine, name, failed);

      if (picked.agent === account.agent && picked.name !== account.name) {
        return yield* failed(
          `roles.${role} is ${picked.name}, a ${picked.agent} account like the persona's own (${account.name}); a role's account must run another agent`,
        );
      }

      accounts[picked.agent] = ownAccount(picked);
      agents[role] = picked.agent;
    }

    return { accounts, agents };
  });

// Merges the layers for one persona of a repo. `configDir` is where its
// .chernabog/ was read from; `env` is the extra environment its commands run with.
const mergePersona = (
  machine: MachineConfig,
  enrolled: EnrolledRepo,
  repo: RepoConfigFile,
  persona: Persona,
  configDir: string,
  env: Environment,
) =>
  Effect.gen(function* () {
    const failed = (message: string) =>
      new ConfigError({ message: `${enrolled.repo}${asSuffix(persona)}: ${message}` });

    const own = choicesOf(enrolled, persona);

    const accountName = Option.getOrElse(
      Option.orElse(Option.fromUndefinedOr(own.account), () =>
        Option.map(Arr.head(machine.accounts), (first) => first.name),
      ),
      () => "work",
    );

    const account = yield* findAccount(machine, accountName, failed);

    // A persona with its own default schedule chooses when every flow runs
    // for it, so the team's per-flow schedules give way to it.
    const teamFlows = Record.map(
      repo.flows ?? {},
      ({ runners: _runners, ...settings }): FlowSettings => settings,
    );

    const repoFlows = Option.match(Option.fromUndefinedOr(own.schedule), {
      onNone: () => teamFlows,
      onSome: () => Record.map(teamFlows, ({ schedule: _schedule, ...settings }) => settings),
    });

    const ownFlows = Record.map(
      own.flows ?? {},
      ({ runners: _runners, ...settings }): FlowSettings => settings,
    );

    const flows = mergeFlows([repoFlows, ownFlows], machine.concurrency);
    const agent = own.agent ?? repo.agent ?? account.agent;
    const roles = yield* otherAccounts(machine, own, account, failed);
    const agentAccounts = { ...accountsByAgent(machine, account), ...roles.accounts };
    const launcher = yield* resolveLauncher(machine, repoNameOf(enrolled), { repo, own });

    const settings: RepoSettings = {
      name: repoNameOf(enrolled),
      slug: enrolled.repo,
      path: enrolled.path,
      baseBranch: repo.baseBranch ?? enrolled.baseBranch ?? "main",
      account: agentAccounts[agent] ?? ownAccount(account),
      agent,
      agentAccounts,
      launcher,
      flowAgents: Object.fromEntries(
        Object.entries(flows).flatMap(([flow, chosen]) =>
          Option.toArray(
            Option.map(Option.fromUndefinedOr(chosen.agent), (adapter) => [flow, adapter] as const),
          ),
        ),
      ),
      flowRoleAgents: Object.fromEntries(
        Object.entries(flows).flatMap(([flow, chosen]) =>
          Option.toArray(
            Option.map(Option.fromUndefinedOr(chosen.agents), (byRole) => [flow, byRole] as const),
          ),
        ),
      ),
      roleAgents: roles.agents,
      labels: { ...DEFAULT_LABELS, ...repo.labels },
      install: Option.flatten(Option.fromUndefinedOr(repo.install)),
      localGate: repo.localGate ?? [],
      humanOnly: [...machine.humanOnly, ...(repo.humanOnly ?? [])],
      humanOnlyPaths: repo.humanOnlyPaths ?? [".github/**"],
      notes: repo.notes ?? [],
      board: Option.flatten(Option.fromUndefinedOr(repo.board)),
      reviewTrigger: Option.flatten(Option.fromUndefinedOr(repo.reviewTrigger)),
      ...Option.match(Option.fromUndefinedOr(repo.reviewers), {
        onNone: () => ({}),
        onSome: (reviewers) => ({ reviewers }),
      }),
      limits: limitsFrom(repo.limits),
      env,
      configDir,
    };

    return {
      persona,
      settings,
      enabled: own.enabled ?? true,
      schedule: {
        own: Option.fromUndefinedOr(own.schedule),
        repo: Option.fromUndefinedOr(repo.schedule),
      },
      activeHours: Option.fromUndefinedOr(own.activeHours),
      flows,
      chosen: Object.entries(ownFlows).flatMap(([flow, chosen]) =>
        Option.toArray(Option.liftPredicate(flow, () => chosen.enabled !== false)),
      ),
      own,
      teamFlows,
    } satisfies PersonaRepo;
  });

// Merges the layers for each persona of a repo.
export const mergeRepoConfig = (
  machine: MachineConfig,
  enrolled: EnrolledRepo,
  repo: RepoConfigFile,
  configDir: string,
  env: Environment,
) =>
  Effect.gen(function* () {
    const [first, ...rest] = yield* personasOf(machine, enrolled);

    const merge = (persona: Persona) =>
      mergePersona(machine, enrolled, repo, persona, configDir, env);

    const head = yield* merge(first);
    const tail = yield* Effect.forEach(rest, merge);

    return { settings: head.settings, personas: [head, ...tail] } satisfies EffectiveRepo;
  });

// launchd and systemd start with a bare PATH and no nvm, so the repo's pinned Node goes first.
export const repoEnvironment = (checkout: string) =>
  Effect.gen(function* () {
    const bin = yield* nodeBinFor(checkout);
    const host = yield* HostEnvironment;

    return Option.match(bin, {
      onNone: () => ({}),
      onSome: (dir) => ({
        PATH: `${dir}:${Option.getOrElse(Record.get(host.variables, "PATH"), () => "/usr/bin:/bin")}`,
      }),
    });
  });

// Reads the repo's committed config from `configDir` (the trusted snapshot).
// A .chernabog/ that needs a newer binary is refused first. Past that, a key
// this binary doesn't know is a typo or a newer key the floor wasn't raised
// for, and either one may be a rule the repo counts on, so it fails the repo
// instead of being dropped.
export const loadRepo = (machine: MachineConfig, enrolled: EnrolledRepo, configDir: string) =>
  Effect.gen(function* () {
    yield* checkConfigVersion(configDir);
    const repo = yield* readYaml(RepoConfigFile, `${configDir}/config.yaml`, true);

    return yield* mergeRepoConfig(
      machine,
      enrolled,
      repo,
      configDir,
      yield* repoEnvironment(enrolled.path),
    );
  });

// Edits machine config in place, keeping the file's comments. `edit` changes
// the document, given the file as it decodes now, and says what it did.
export const editMachineConfig = <A, E, R>(
  edit: (document: YAML.Document, current: MachineConfigFile) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const file = homePaths(home.root).machineConfig;

    const platform = <B>(effect: Effect.Effect<B, PlatformError.PlatformError>) =>
      effect.pipe(Effect.mapError((error) => new ConfigError({ message: error.message })));

    yield* platform(fs.makeDirectory(home.root, { recursive: true }));
    let document = new YAML.Document({});

    if (yield* platform(fs.exists(file))) {
      document = YAML.parseDocument(yield* platform(fs.readFileString(file)));
    }

    const decoded = yield* Schema.decodeUnknownEffect(MachineConfigFile)(
      document.toJS() ?? {},
    ).pipe(Effect.mapError((issue) => new ConfigError({ message: `${file}: ${issue.message}` })));

    // Paths as the rest of chernabog sees them; the document keeps them as written.
    const current = {
      ...decoded,
      repos: (decoded.repos ?? []).map((entry) => ({
        ...entry,
        path: expandHome(entry.path, home.user),
      })),
    };

    const result = yield* edit(document, current);
    yield* platform(writeFileAtomic(fs, file, document.toString()));

    return result;
  });

// The entry a repo's enrolment updates, and its index; none when the repo
// isn't enrolled yet.
export const entryFor = (repos: ReadonlyArray<EnrolledRepo>, repo: EnrolledRepo) =>
  Effect.fromResult(
    EnrolledRepoRootOps.entryFor(repos.map(toRoot), {
      repo: repo.repo,
      name: Option.fromUndefinedOr(repo.name),
      path: repo.path,
    }),
  ).pipe(
    Effect.map(Option.map((index) => ({ entry: repos[index], index }))),
    Effect.mapError((ambiguous) => new ConfigError({ message: ambiguous.message })),
  );
