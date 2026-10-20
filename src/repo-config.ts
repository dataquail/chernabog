// The three config layers. The team decides what work gets done and how
// (.chernabog/config.yaml, committed); each person decides when it runs, which
// agent it uses (.chernabog/local.yaml, gitignored) and how much of their
// budget it spends (~/.config/chernabog/config.yaml). Later layers override
// earlier ones key by key, except that a repo can never raise machine limits,
// and a person's launcher must be one the repo allows.

import { type Account, DEFAULT_LABELS, type LauncherCommands, type Limits, type RepoSettings, type ResolvedLauncher } from '@chernabog/sdk';
import * as Arr from 'effect/Array';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';

import type { AgentsConfig } from './agents.ts';
import { ConfigError, expandHome, Home, homePaths } from './config.ts';
import { checkConfigVersion } from './flow-deps.ts';
import { BUILT_IN_LAUNCHERS, type LaunchersConfig } from './launchers.ts';
import { nodeBinFor } from './node-version.ts';
import { type Environment, HostEnvironment } from './platform/environment.ts';
import type { GateConfig } from './usage-gate.ts';

const Strings = Schema.Array(Schema.String);

const DURATION = /^(\d+(?:\.\d+)?)\s*(millis?|seconds?|minutes?|hours?|days?|weeks?)$/;

const UNIT_MILLIS: Readonly<Record<string, number>> = { milli: 1, second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

// "6 hours", "90 minutes": the durations config may name.
export const parseDuration = (text: string) =>
  Option.fromNullishOr(DURATION.exec(text.trim())).pipe(
    Option.flatMap((match) => Option.map(Record.get(UNIT_MILLIS, match[2].replace(/s$/, '')), (millis) => Duration.millis(Number(match[1]) * millis))),
  );

const DurationText = Schema.String.pipe(Schema.check(Schema.makeFilter((text: string) => Option.isSome(parseDuration(text)) || `"${text}" is not a duration, such as "6 hours"`)));

const FlowSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(Schema.String),
  concurrency: Schema.optionalKey(Schema.Int),
  agent: Schema.optionalKey(Schema.String),
});

export type FlowSettings = typeof FlowSettings.Type;

// GitHub logins whose machines run a flow by default; anyone's, when left out.
const Runners = Schema.Array(Schema.String).annotate({
  description: "GitHub logins whose machines run this by default; anyone's when unset. A person can still turn a flow on in their local.yaml.",
});

const RepoFlowSettings = Schema.Struct({ ...FlowSettings.fields, runners: Schema.optionalKey(Runners) });

const LimitsFile = Schema.Struct({
  localGateRounds: Schema.optionalKey(Schema.Int),
  ciRounds: Schema.optionalKey(Schema.Int),
  reviewRounds: Schema.optionalKey(Schema.Int),
  staleAfter: Schema.optionalKey(DurationText),
  ciTimeout: Schema.optionalKey(DurationText),
});

const Board = Schema.Struct({ projectNumber: Schema.Int, readyStatus: Schema.String, inProgressStatus: Schema.String });

const LabelsFile = Schema.Struct({
  eligible: Schema.optionalKey(Schema.String),
  inProgress: Schema.optionalKey(Schema.String),
  needsReview: Schema.optionalKey(Schema.String),
  changesRequested: Schema.optionalKey(Schema.String),
  approved: Schema.optionalKey(Schema.String),
  needsHuman: Schema.optionalKey(Schema.String),
  needsClarification: Schema.optionalKey(Schema.String),
  stale: Schema.optionalKey(Schema.String),
});

// Launcher commands run in a person's own terminal setup, so a repo can name launchers but never define one.
const MACHINE_ONLY = 'launcher commands can only be defined in machine config (~/.config/chernabog/config.yaml)';
const TEAM_ONLY = 'runners is the team\'s choice, in .chernabog/config.yaml; to run a flow here anyway, set flows.<flow>.enabled: true';

// No value is allowed, so editors flag the key too.
const MachineOnly = Schema.optionalKey(Schema.Never.annotate({ description: MACHINE_ONLY, message: MACHINE_ONLY }));
const TeamOnly = Schema.optionalKey(Schema.Never.annotate({ description: TEAM_ONLY, message: TEAM_ONLY }));

const LocalFlowSettings = Schema.Struct({ ...FlowSettings.fields, runners: TeamOnly });

// A YAML null turns the setting off.
const Nullable = <S extends Schema.Constraint>(schema: S) => Schema.optionalKey(Schema.OptionFromNullOr(schema));

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
  flows: Schema.optionalKey(Schema.Record(Schema.String, RepoFlowSettings)),
});

export type RepoConfigFile = typeof RepoConfigFile.Type;

// .chernabog/local.yaml: when it runs for this person. Gitignored.
export const LocalConfigFile = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(Schema.String),
  activeHours: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  launcher: Schema.optionalKey(Schema.String),
  launchers: MachineOnly,
  runners: TeamOnly,
  flows: Schema.optionalKey(Schema.Record(Schema.String, LocalFlowSettings)),
});

export type LocalConfigFile = typeof LocalConfigFile.Type;

const AccountFile = Schema.Struct({
  configDir: Nullable(Schema.String),
  expectedEmail: Nullable(Schema.String),
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

export const EnrolledRepo = Schema.Struct({
  path: Schema.String,
  repo: Schema.String,
  name: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String),
  // The branch .chernabog/ is trusted from. Defaults to main.
  baseBranch: Schema.optionalKey(Schema.String),
});

export type EnrolledRepo = typeof EnrolledRepo.Type;

export const UsageGateFile = Schema.Struct({
  targetEndUsage: Schema.Finite,
  taskCostEstimate: Schema.Finite,
  fiveHourCeiling: Schema.Finite,
  humanRatePerHour: Schema.Finite,
});

// ~/.config/chernabog/config.yaml: budget and accounts, for this machine only.
export const MachineConfigFile = Schema.Struct({
  accounts: Schema.optionalKey(Schema.Record(Schema.String, AccountFile)),
  usageGate: Schema.optionalKey(UsageGateFile),
  concurrency: Schema.optionalKey(Schema.Int),
  quietHours: Schema.optionalKey(Schema.String),
  humanOnly: Schema.optionalKey(Strings),
  agents: Schema.optionalKey(Schema.Record(Schema.String, AgentFile)),
  // Your launcher for every repo, and launchers of your own. Only here, never in a repo.
  launcher: Schema.optionalKey(Schema.String),
  launchers: Schema.optionalKey(Schema.Record(Schema.String, LauncherFile)),
  repos: Schema.optionalKey(Schema.Array(EnrolledRepo)),
});

export type MachineConfigFile = typeof MachineConfigFile.Type;

export const DEFAULT_GATE: GateConfig = { targetEndUsage: 0.95, taskCostEstimate: 0.04, fiveHourCeiling: 0.4, humanRatePerHour: 0.005 };

export const DEFAULT_LIMITS: Limits = { localGateRounds: 2, ciRounds: 3, reviewRounds: 3, staleAfter: Duration.hours(6), ciTimeout: Duration.hours(2) };

// Each account belongs to one agent: claude unless it says otherwise.
export type MachineAccount = Account & { readonly agent: string };

export type MachineConfig = {
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

// One enrolled repo with every layer merged.
export type EffectiveRepo = {
  readonly settings: RepoSettings;
  readonly enabled: boolean;
  // The repo-wide default from each layer. The person's beats every schedule
  // the team sets, a flow's own included; the team's is the last fallback.
  readonly schedule: { readonly local: Option.Option<string>; readonly repo: Option.Option<string> };
  readonly activeHours: Option.Option<string>;
  readonly flows: Readonly<Record<string, FlowSettings>>;
  // Whose machines run each flow by default, by GitHub login: the flow's own
  // list, else the repo's; anyone's without either.
  readonly runners: { readonly repo: Option.Option<ReadonlyArray<string>>; readonly flows: Readonly<Record<string, ReadonlyArray<string>>> };
  // The flows the person turned on or off in local.yaml, which beat the runners.
  readonly localEnabled: Readonly<Record<string, boolean>>;
};

export const FLOW_TURNED_OFF = 'flow turned off';

// Why this machine doesn't run a flow with these runners, if it doesn't.
export const notARunner = (runners: ReadonlyArray<string>, login: Option.Option<string>) => {
  const isRunner = Option.exists(login, (self) => runners.some((runner) => runner.toLowerCase() === self.toLowerCase()));
  const who = Option.match(login, { onNone: () => "this machine's GitHub login is unknown", onSome: (self) => `this machine is ${self}` });

  return Option.liftPredicate(`not a runner (runners: ${runners.join(', ')}; ${who})`, () => !isRunner);
};

export const runnersOf = (repo: EffectiveRepo, flow: string) => Option.orElse(Record.get(repo.runners.flows, flow), () => repo.runners.repo);

export const hasRunners = (repo: EffectiveRepo) => Option.isSome(repo.runners.repo) || Object.keys(repo.runners.flows).length > 0;

// Why a flow doesn't run on this machine, if it doesn't: the person's own
// choice in local.yaml, else the team's flows.<flow>.enabled, else whether
// this machine's GitHub login is one of the flow's runners. Logins are
// case-insensitive, as on GitHub.
export const flowOff = (repo: EffectiveRepo, flow: string, login: Option.Option<string>): Option.Option<string> => {
  const own = Record.get(repo.localEnabled, flow);

  if (Option.isSome(own)) return Option.liftPredicate(FLOW_TURNED_OFF, () => !own.value);

  if (Option.exists(Record.get(repo.flows, flow), (settings) => settings.enabled === false)) return Option.some(FLOW_TURNED_OFF);

  return Option.flatMap(runnersOf(repo, flow), (runners) => notARunner(runners, login));
};

// A YAML file decoded into a schema's type; an absent file is an empty one.
// `strict` refuses keys the schema doesn't name, rather than dropping them.
export const readYaml = <A, I>(schema: Schema.Codec<A, I>, file: string, strict = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failed = (message: string) => new ConfigError({ message: `${file}: ${message}` });
    // An absent or empty file sets nothing.
    let text = '{}';

    if (yield* fs.exists(file)) text = yield* fs.readFileString(file);

    if (text.trim().length === 0) text = '{}';

    const document = YAML.parseDocument(text);

    if (document.errors.length > 0) return yield* failed(document.errors.map((error) => error.message).join('; '));

    let onExcessProperty: 'error' | 'ignore' = 'ignore';

    if (strict) onExcessProperty = 'error';

    return yield* Schema.decodeUnknownEffect(schema)(document.toJS(), { onExcessProperty }).pipe(Effect.mapError((issue) => failed(issue.message)));
  }).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new ConfigError({ message: `${file}: ${error.message}` }))));

export const machineConfigFile = Home.use((home) => Effect.succeed(homePaths(home.root).machineConfig));

const fromAccountFile = (home: string) => (entry: readonly [string, typeof AccountFile.Type]): MachineAccount => {
  const [name, account] = entry;

  return {
    name,
    configDir: Option.map(Option.flatten(Option.fromUndefinedOr(account.configDir)), (dir) => expandHome(dir, home)),
    expectedEmail: Option.flatten(Option.fromUndefinedOr(account.expectedEmail)),
    agent: account.agent ?? 'claude',
  };
};

const launcherCommandsOf = (file: typeof LauncherFile.Type): LauncherCommands => ({
  start: file.start,
  close: file.close,
  alive: Option.fromUndefinedOr(file.alive),
  attach: Option.fromUndefinedOr(file.attach),
});

export const normalizeMachineConfig = (file: MachineConfigFile, home: string): MachineConfig => ({
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

export const repoNameOf = (repo: EnrolledRepo) => repo.name ?? repo.repo.split('/').at(-1) ?? repo.repo;

export const findEnrolled = (machine: MachineConfig, name: string) =>
  Effect.fromOption(Arr.findFirst(machine.repos, (repo) => repoNameOf(repo) === name || repo.repo === name || repo.path === name)).pipe(
    Effect.mapError(() => {
      const enrolled = machine.repos.map(repoNameOf).join(', ');

      let known = 'none';

      if (enrolled.length > 0) known = enrolled;

      return new ConfigError({ message: `no enrolled repo named ${name} (enrolled: ${known}); run chernabog enroll in it` });
    }),
  );

const mergeFlows = (layers: ReadonlyArray<Readonly<Record<string, FlowSettings>>>, machineConcurrency: number) => {
  const merged: Record<string, FlowSettings> = {};

  for (const layer of layers) for (const [name, settings] of Object.entries(layer)) merged[name] = { ...merged[name], ...settings };

  // A repo can lower concurrency, never raise it past the machine's.
  return Record.map(merged, (settings) =>
    Option.match(Option.fromUndefinedOr(settings.concurrency), {
      onNone: () => settings,
      onSome: (concurrency) => ({ ...settings, concurrency: Math.min(concurrency, machineConcurrency) }),
    }),
  );
};

const ownAccount = (account: MachineAccount): Account => ({ name: account.name, configDir: account.configDir, expectedEmail: account.expectedEmail });

// The repo's own account for its agent; for any other agent, that agent's first account.
const accountsByAgent = (machine: MachineConfig, own: MachineAccount) => {
  const byAgent: Record<string, Account> = {};

  for (const candidate of machine.accounts) if (!(candidate.agent in byAgent)) byAgent[candidate.agent] = ownAccount(candidate);

  byAgent[own.agent] = ownAccount(own);

  return byAgent;
};

const limitsFrom = (file: RepoConfigFile['limits']): Limits => ({
  localGateRounds: file?.localGateRounds ?? DEFAULT_LIMITS.localGateRounds,
  ciRounds: file?.ciRounds ?? DEFAULT_LIMITS.ciRounds,
  reviewRounds: file?.reviewRounds ?? DEFAULT_LIMITS.reviewRounds,
  staleAfter: Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(file?.staleAfter), parseDuration), () => DEFAULT_LIMITS.staleAfter),
  ciTimeout: Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(file?.ciTimeout), parseDuration), () => DEFAULT_LIMITS.ciTimeout),
});

// Unlike the agent, the launcher describes the person's own machine, so their
// choice beats the team's default: local.yaml, then machine config, then the
// repo. The team limits it with allowedLaunchers, and a launcher outside that
// list fails the repo instead of quietly running under another one.
export const resolveLauncher = (machine: MachineConfig, repoName: string, files: { readonly repo: RepoConfigFile; readonly local: LocalConfigFile }) =>
  Effect.gen(function* () {
    const chosen = Arr.findFirst(
      [
        { from: 'local.yaml', name: Option.fromUndefinedOr(files.local.launcher) },
        { from: 'machine config', name: machine.launcher },
        { from: 'repo config', name: Option.fromUndefinedOr(files.repo.launcher) },
      ],
      (layer) => Option.isSome(layer.name),
    );

    const { from, name } = Option.getOrElse(
      Option.flatMap(chosen, (layer) => Option.map(layer.name, (found) => ({ from: layer.from, name: found }))),
      () => ({ from: 'default', name: 'headless' }),
    );

    // A custom launcher can't take a built-in's name.
    const custom = Option.filter(Record.get(machine.launchers, name), () => !BUILT_IN_LAUNCHERS.includes(name));

    if (!BUILT_IN_LAUNCHERS.includes(name) && Option.isNone(custom)) {
      const known = [...BUILT_IN_LAUNCHERS, ...Object.keys(machine.launchers).filter((own) => !BUILT_IN_LAUNCHERS.includes(own))];

      return yield* new ConfigError({ message: `unknown launcher "${name}" (from ${from}); known launchers: ${known.join(', ')}` });
    }

    const allowed = Option.fromUndefinedOr(files.repo.allowedLaunchers);

    if (Option.isSome(allowed) && !allowed.value.includes(name)) {
      return yield* new ConfigError({ message: `launcher "${name}" (from ${from}) isn't allowed by ${repoName}'s config: allowedLaunchers is ${allowed.value.join(', ')}` });
    }

    return { name, from, custom } satisfies ResolvedLauncher;
  });

// Merges the layers for one repo. `configDir` is where its .chernabog/ was read
// from; `env` is the extra environment its commands run with.
export const mergeRepoConfig = (machine: MachineConfig, enrolled: EnrolledRepo, files: { readonly repo: RepoConfigFile; readonly local: LocalConfigFile }, configDir: string, env: Environment) =>
  Effect.gen(function* () {
    const accountName = Option.getOrElse(Option.orElse(Option.fromUndefinedOr(enrolled.account), () => Option.map(Arr.head(machine.accounts), (first) => first.name)), () => 'work');
    const found = Arr.findFirst(machine.accounts, (candidate) => candidate.name === accountName);

    if (Option.isNone(found)) {
      return yield* new ConfigError({ message: `${enrolled.repo}: account "${accountName}" is not one of ${machine.accounts.map((known) => known.name).join(', ')}` });
    }

    const account = found.value;
    const { local, repo } = files;

    // A person who sets their own default schedule chooses when every flow
    // runs for them, so the team's per-flow schedules give way to it.
    const teamFlows = Record.map(repo.flows ?? {}, ({ runners: _runners, ...settings }): FlowSettings => settings);

    const repoFlows = Option.match(Option.fromUndefinedOr(local.schedule), {
      onNone: () => teamFlows,
      onSome: () => Record.map(teamFlows, ({ schedule: _schedule, ...settings }) => settings),
    });

    const localFlows = Record.map(local.flows ?? {}, ({ runners: _runners, ...settings }): FlowSettings => settings);
    const flows = mergeFlows([repoFlows, localFlows], machine.concurrency);
    const agent = local.agent ?? repo.agent ?? account.agent;
    const agentAccounts = accountsByAgent(machine, account);
    const launcher = yield* resolveLauncher(machine, repoNameOf(enrolled), files);

    const settings: RepoSettings = {
      name: repoNameOf(enrolled),
      slug: enrolled.repo,
      path: enrolled.path,
      baseBranch: repo.baseBranch ?? enrolled.baseBranch ?? 'main',
      account: agentAccounts[agent] ?? ownAccount(account),
      agent,
      agentAccounts,
      launcher,
      flowAgents: Object.fromEntries(Object.entries(flows).flatMap(([flow, chosen]) => Option.toArray(Option.map(Option.fromUndefinedOr(chosen.agent), (adapter) => [flow, adapter] as const)))),
      labels: { ...DEFAULT_LABELS, ...repo.labels },
      install: Option.flatten(Option.fromUndefinedOr(repo.install)),
      localGate: repo.localGate ?? [],
      humanOnly: [...machine.humanOnly, ...(repo.humanOnly ?? [])],
      humanOnlyPaths: repo.humanOnlyPaths ?? ['.github/**'],
      notes: repo.notes ?? [],
      board: Option.flatten(Option.fromUndefinedOr(repo.board)),
      reviewTrigger: Option.flatten(Option.fromUndefinedOr(repo.reviewTrigger)),
      limits: limitsFrom(repo.limits),
      env,
      configDir,
    };

    return {
      settings,
      enabled: local.enabled ?? true,
      schedule: { local: Option.fromUndefinedOr(local.schedule), repo: Option.fromUndefinedOr(repo.schedule) },
      activeHours: Option.fromUndefinedOr(local.activeHours),
      flows,
      runners: {
        repo: Option.fromUndefinedOr(repo.runners),
        flows: Object.fromEntries(Object.entries(repo.flows ?? {}).flatMap(([flow, chosen]) => Option.toArray(Option.map(Option.fromUndefinedOr(chosen.runners), (runners) => [flow, runners] as const)))),
      },
      localEnabled: Object.fromEntries(Object.entries(localFlows).flatMap(([flow, chosen]) => Option.toArray(Option.map(Option.fromUndefinedOr(chosen.enabled), (enabled) => [flow, enabled] as const)))),
    } satisfies EffectiveRepo;
  });

// launchd and systemd start with a bare PATH and no nvm, so the repo's pinned Node goes first.
export const repoEnvironment = (checkout: string) =>
  Effect.gen(function* () {
    const bin = yield* nodeBinFor(checkout);
    const host = yield* HostEnvironment;

    return Option.match(bin, {
      onNone: () => ({}),
      onSome: (dir) => ({ PATH: `${dir}:${Option.getOrElse(Record.get(host.variables, 'PATH'), () => '/usr/bin:/bin')}` }),
    });
  });

// Reads the repo's committed config from `configDir` (the trusted snapshot)
// and the person's local.yaml from the working checkout. A .chernabog/ that
// needs a newer binary is refused first. Past that, a key this binary doesn't
// know is a typo or a newer key the floor wasn't raised for, and either one
// may be a rule the repo counts on, so it fails the repo instead of being dropped.
export const loadRepo = (machine: MachineConfig, enrolled: EnrolledRepo, configDir: string) =>
  Effect.gen(function* () {
    yield* checkConfigVersion(configDir);
    const repo = yield* readYaml(RepoConfigFile, `${configDir}/config.yaml`, true);
    const local = yield* readYaml(LocalConfigFile, `${enrolled.path}/.chernabog/local.yaml`);

    return yield* mergeRepoConfig(machine, enrolled, { repo, local }, configDir, yield* repoEnvironment(enrolled.path));
  });

// Adds or updates a repo in machine config, keeping the file's comments.
export const enrollInMachineConfig = (repo: EnrolledRepo) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const file = homePaths(home.root).machineConfig;
    yield* fs.makeDirectory(home.root, { recursive: true });
    let document = new YAML.Document({});

    if (yield* fs.exists(file)) document = YAML.parseDocument(yield* fs.readFileString(file));

    const current = yield* Schema.decodeUnknownEffect(MachineConfigFile)(document.toJS() ?? {}).pipe(Effect.mapError((issue) => new ConfigError({ message: `${file}: ${issue.message}` })));
    const index = (current.repos ?? []).findIndex((entry) => entry.repo === repo.repo);
    let action: 'added' | 'updated' = 'added';

    if (index >= 0) {
      document.setIn(['repos', index], document.createNode(repo));
      action = 'updated';
    } else if (document.has('repos')) document.addIn(['repos'], document.createNode(repo));
    else document.set('repos', document.createNode([repo]));

    yield* fs.writeFileString(file, document.toString());

    return action;
  }).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new ConfigError({ message: error.message }))));
