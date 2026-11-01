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
  isManual,
  type Json,
  type LauncherCommands,
  type Limits,
  type RepoSettings,
  type ResolvedLauncher,
  type Settings,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { howToStart } from "./kernel/manual-flow.value-object.ts";
import { asSuffix, IMPLICIT, type Persona, samePersona } from "./kernel/persona.value-object.ts";
import { StandIns } from "./kernel/stand-in.value-object.ts";
import { EnrolledRepoRootOps } from "./modules/enrollment/domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { FlowSettings } from "./modules/enrollment/domain/enrolled-repo/flow-settings.value-object.ts";
import { type PersonaEntry } from "./modules/enrollment/domain/enrolled-repo/persona-choices.aggregate.ts";
import { FLOW_TURNED_OFF } from "./modules/enrollment/domain/enrolled-repo/team-flows.value-object.ts";
import {
  type EnrolledRepoEntry,
  EnrolledRepoEntry as EnrolledRepoSchema,
  toRoot as entryToRoot,
} from "./modules/enrollment/infrastructure/repositories/enrolled-repo.mapper.ts";
import { DEFAULT_EVENT_TICK_MIN } from "./modules/runs/domain/schedule/event-tick.value-object.ts";
import {
  DEFAULT_LEASE_LIMITS,
  type LeaseLimits,
} from "./modules/runs/domain/schedule/lease.value-object.ts";
import { chooseSchedule } from "./modules/runs/domain/schedule/schedule.value-object.ts";
import { DEFAULT_VALIDITY_EVERY } from "./modules/runs/domain/schedule/validity.value-object.ts";
import type { AgentsConfig } from "./modules/runs/infrastructure/runtime/agents.ts";
import {
  BUILT_IN_LAUNCHERS,
  type LaunchersConfig,
} from "./modules/runs/infrastructure/runtime/launchers.ts";
import type { GateConfig } from "./modules/runs/infrastructure/runtime/usage-gate.ts";
import { describeNewerStamp, stampState } from "./platform/backups.ts";
import { ConfigError } from "./platform/config-error.ts";
import { knownDefaultBranch } from "./platform/config-snapshot.ts";
import { type Environment, HostEnvironment } from "./platform/environment.ts";
import { updateFile } from "./platform/file-lock.ts";
import { checkRunnable } from "./platform/flow-deps.ts";
import { type PackageOverrides } from "./platform/flow-loader.ts";
import { expandHome, Home, homePaths } from "./platform/home.ts";
import { nodeBinFor } from "./platform/node-version.ts";

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

// A flow imported from a recipe package rather than copied into flows/.
const FlowFrom = Schema.String.annotate({
  description:
    'Runs this flow from a recipe package installed in .chernabog/ (its package.json\'s dependencies), instead of a file in flows/: "<package>/<recipe>", such as "@chernabog/recipes/review". The package\'s team owns it; a prompt in prompts/ overrides the package\'s. chernabog recipes eject copies it in.',
});

const RepoFlowSettings = Schema.Struct({
  ...FlowSettings.fields,
  runners: Schema.optionalKey(Runners),
  from: Schema.optionalKey(FlowFrom),
});

// A key a flow's settings hold now, kept until core's next major (ADR 0005).
const deprecated = (key: string) =>
  `Deprecated: set ${key} under settings: (every flow) or flows.<name>.settings, where the flows that use it read it. A flow's settings win over this.`;

// A recipe's limit, kept here until core's next major (ADR 0005).
const recipeLimit = <S extends Schema.Top>(key: string, schema: S) =>
  Schema.optionalKey(schema.annotate({ description: deprecated(key) }));

const LimitsFile = Schema.Struct({
  localGateRounds: recipeLimit("localGateRounds", Schema.Int),
  ciRounds: recipeLimit("ciRounds", Schema.Int),
  reviewRounds: recipeLimit("reviewRounds", Schema.Int),
  staleAfter: recipeLimit("staleAfter", DurationText),
  ciTimeout: recipeLimit("ciTimeout", DurationText),
  // The least time between two ticks of a persona's flow that events ask for (#138).
  eventTickMin: Schema.optionalKey(DurationText),
  // How often the daemon asks whether each run's work item is still valid (#142).
  validityEvery: Schema.optionalKey(DurationText),
  // How long a run's claim lasts unless its daemon renews it, executing and
  // parked, and how often the daemon renews it (#134).
  leaseTtl: Schema.optionalKey(DurationText),
  parkedLeaseTtl: Schema.optionalKey(DurationText),
  leaseRenewEvery: Schema.optionalKey(DurationText),
  planNodes: recipeLimit("planNodes", Schema.Int),
  planRounds: recipeLimit("planRounds", Schema.Int),
  stackDepth: recipeLimit("stackDepth", Schema.Int),
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

// What every flow's settings start from, before flows.<name>.settings.
const SharedSettings = Schema.Record(Schema.String, Schema.Json).annotate({
  description:
    "Settings every flow shares, such as the reviewer pool (reviewers), the CI limits (ciRounds, ciTimeout) and the local gate (localGate, install), read by the flows whose settings declare them. flows.<name>.settings overrides them key by key.",
});

// .chernabog/config.yaml: what work gets done and how. Committed.
export const RepoConfigFile = Schema.Struct({
  baseBranch: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Deprecated: set base under settings: (every flow) or flows.<name>.settings, the branch a flow's work starts from and targets. It never chose the branch .chernabog/ is read from, which is GitHub's default. A flow's base wins over this.",
    }),
  ),
  settings: Schema.optionalKey(SharedSettings),
  install: Nullable(Schema.String.annotate({ description: deprecated("install") })),
  localGate: Schema.optionalKey(Strings.annotate({ description: deprecated("localGate") })),
  humanOnly: Schema.optionalKey(Strings.annotate({ description: deprecated("humanOnly") })),
  humanOnlyPaths: Schema.optionalKey(
    Strings.annotate({ description: deprecated("humanOnlyPaths") }),
  ),
  notes: Schema.optionalKey(Strings.annotate({ description: deprecated("notes") })),
  board: Nullable(Board.annotate({ description: deprecated("board") })),
  // Read by nothing; accepted, so a config that sets it still loads, until core's next major.
  reviewTrigger: Nullable(
    Schema.String.annotate({ description: "Deprecated, and has no effect." }),
  ),
  labels: Schema.optionalKey(LabelsFile.annotate({ description: deprecated("labels") })),
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
      description: `The reviewer pool, by GitHub login. ${deprecated("reviewers")}`,
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
  // The rehearsal agent's answers, by step name (#115): `agents.rehearsal.standIns`.
  standIns: Schema.optionalKey(StandIns),
  // Where the stand-ins' files are, given to scripts as CHERNABOG_STAND_INS;
  // machine config's own directory when left out.
  dir: Schema.optionalKey(Schema.String),
  // Every agent call goes to this agent, whatever adapter a flow or role asks
  // for, so no real agent can start. `chernabog rehearse` sets it.
  exclusive: Schema.optionalKey(Schema.Boolean),
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
// Which events tick a persona's flows sooner than cron (#138): a change a run
// here makes, and the persona's GitHub notifications.
const EventsFile = Schema.Struct({
  local: Schema.optionalKey(Schema.Boolean),
  notifications: Schema.optionalKey(Schema.Boolean),
});

const GitHubPersonaFile = Schema.Struct({
  events: Schema.optionalKey(EventsFile),
});

// ~/.config/chernabog/config.yaml: budget and accounts, for this machine only.
// The key machine config is stamped with: the chernabog that last migrated it.
export const STAMP_KEY = "chernabog";

export const MachineConfigFile = Schema.Struct({
  // The chernabog that last migrated this file (src/platform/backups.ts).
  [STAMP_KEY]: Schema.optionalKey(Schema.String),
  // GitHub personas by login. Without it, the one persona is whoever the
  // daemon is: GH_TOKEN, then GITHUB_TOKEN, then gh's active account.
  github: Schema.optionalKey(Schema.Record(Schema.String, GitHubPersonaFile)),
  accounts: Schema.optionalKey(Schema.Record(Schema.String, AccountFile)),
  usageGate: Schema.optionalKey(UsageGateFile),
  concurrency: Schema.optionalKey(Schema.Int),
  quietHours: Schema.optionalKey(Schema.String),
  humanOnly: Schema.optionalKey(Strings),
  // Every persona's events, unless its github: entry says otherwise.
  events: Schema.optionalKey(EventsFile),
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
  planNodes: 12,
  planRounds: 2,
  stackDepth: 4,
};

// A change a run here makes ticks the repo's flows; notifications wait until
// they have run for a while.
export const DEFAULT_EVENTS: Events = { local: true, notifications: false };

export type Events = { readonly local: boolean; readonly notifications: boolean };

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
  // Which events tick each persona's flows: machine config's own, and each login's over it.
  readonly events: {
    readonly all: Events;
    readonly byLogin: Readonly<Record<string, Events>>;
  };
  readonly repos: ReadonlyArray<EnrolledRepo>;
};

// Which events tick a persona's flows.
export const eventsFor = (machine: MachineConfig, persona: Persona): Events =>
  Option.getOrElse(
    Option.flatMap(persona, (login) => Record.get(machine.events.byLogin, login)),
    () => machine.events.all,
  );

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
  // The team's settings: for every flow, before each one's flows.<name>.settings.
  readonly shared: Settings.Input;
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
  // The team's limits.eventTickMin: the least time between two event ticks of a persona's flow.
  readonly eventTickMin: Duration.Duration;
  // The team's limits.validityEvery: how often each run in flight has its work item checked.
  readonly validityEvery: Duration.Duration;
  // The team's limits.leaseTtl, parkedLeaseTtl and leaseRenewEvery: how long a
  // run's claims last, executing and parked, and how often the daemon renews them.
  readonly leases: LeaseLimits;
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

// When a persona's flow ticks: the flow's own setting for the persona in
// machine config, then the persona's default, then the team's: the flow's
// setting in config.yaml, the flow module's, the repo's. `index` of `count`
// spreads the repos without one across the hour. None for a manual flow,
// which never ticks on a schedule.
export const scheduleFor = (
  repo: PersonaRepo,
  flowName: string,
  flow: Flow,
  index: number,
  count: number,
) =>
  Option.map(
    Option.liftPredicate(flow, (found) => !isManual(found)),
    (scheduled) =>
      chooseSchedule(
        {
          flow: Option.flatMap(Record.get(repo.flows, flowName), (settings) =>
            Option.fromUndefinedOr(settings.schedule),
          ),
          persona: repo.schedule.own,
          module: Option.fromUndefinedOr(scheduled.schedule),
          repo: repo.schedule.repo,
        },
        index,
        count,
      ),
  );

// Where config gives a manual flow a schedule of its own: the team's
// config.yaml, or a persona's choices in machine config.
const manualSchedules = (repo: EffectiveRepo, flowName: string) =>
  repo.personas.flatMap((own) => [
    ...Option.toArray(
      Option.as(
        Option.flatMap(Record.get(own.teamFlows, flowName), (settings) =>
          Option.fromUndefinedOr(settings.schedule),
        ),
        "config.yaml",
      ),
    ),
    ...Option.toArray(
      Option.as(
        Option.fromUndefinedOr(own.own.flows?.[flowName]?.schedule),
        `machine config${asSuffix(own.persona)}`,
      ),
    ),
  ]);

// Fails when config gives a manual flow a schedule: nothing would run on it,
// since a person starts each of the flow's runs. A repo's default schedule
// doesn't apply to manual flows, so only a flow's own is refused.
export const checkManualSchedules = (repo: EffectiveRepo, flows: ReadonlyMap<string, Flow>) =>
  Effect.forEach(
    [...flows].filter(([, flow]) => isManual(flow)),
    ([flowName, flow]) =>
      Option.match(Arr.head(Arr.dedupe(manualSchedules(repo, flowName))), {
        onNone: () => Effect.void,
        onSome: (where) =>
          Effect.fail(
            new ConfigError({
              message: `${repo.settings.name}: ${where} gives flows.${flowName} a schedule, but ${flowName} is a manual flow, started only with ${howToStart(flowName, flow.start === true)}; remove the schedule`,
            }),
          ),
      }),
    { discard: true },
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

const eventsOf = (file: MachineConfigFile): MachineConfig["events"] => {
  const all = { ...DEFAULT_EVENTS, ...file.events };

  return {
    all,
    byLogin: Record.map(file.github ?? {}, (persona) => ({ ...all, ...persona.events })),
  };
};

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
  events: eventsOf(file),
  repos: (file.repos ?? []).map((repo) => ({ ...repo, path: expandHome(repo.path, home) })),
});

export const loadMachineConfig = Effect.gen(function* () {
  const home = yield* Home;
  const path = homePaths(home.root).machineConfig;
  const file = yield* readYaml(MachineConfigFile, path);
  const stamp = Option.fromUndefinedOr(file[STAMP_KEY]);

  // A newer chernabog's shape, which this one doesn't know: refused, never misread.
  for (const newer of Option.toArray(Option.filter(stamp, () => stampState(stamp) === "newer"))) {
    return yield* new ConfigError({
      message: yield* describeNewerStamp(home.root, "machine config", path, "config.yaml", newer),
    });
  }

  const machine = normalizeMachineConfig(file, home.user);

  // A rehearsal agent's files are beside machine config unless it says where.
  const agents = Record.map(machine.agents, (agent) =>
    Option.match(Option.fromUndefinedOr(agent.standIns), {
      onNone: () => agent,
      onSome: () => ({ ...agent, dir: expandHome(agent.dir ?? home.root, home.user) }),
    }),
  );

  return { ...machine, agents };
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

const isPlainObject = (value: Json): value is Settings.Input =>
  Predicate.isObject(value) && !Array.isArray(value);

// One setting over another: two objects merge one level down.
const overSetting = (earlier: Option.Option<Json>, value: Json): Json => {
  const objects = Option.filter(earlier, isPlainObject);

  if (Option.isSome(objects) && isPlainObject(value)) {
    return { ...objects.value, ...value };
  }

  return value;
};

// Settings over others, key by key; a key both give as an object merges one
// level down, so a layer can rename one label and keep the rest.
export const mergeSettings = (under: Settings.Input, over: Settings.Input): Settings.Input => ({
  ...under,
  ...Record.map(over, (value, key) => overSetting(Record.get(under, key), value)),
});

// The old flows.<name>.assignee and reviewRequested, as the settings the
// SDK's Routing reads, until core's next major (ADR 0005). null clears the
// team's filter, as it did.
const oldRouting = (settings: FlowSettings): Settings.Input =>
  Record.getSomes({
    assignee: Option.map(Option.fromUndefinedOr(settings.assignee), (who) =>
      Option.getOrNull(Option.map(who, (found): Json => [found].flat())),
    ),
    reviewRequested: Option.map(Option.fromUndefinedOr(settings.reviewRequested), (who) =>
      Option.getOrNull(Option.map(who, (found): Json => [found].flat())),
    ),
  });

// What a persona's flow decodes its settings from: the team's shared
// settings, then the flow's in config.yaml, then the persona's in machine
// config, with the old routing keys under the flow's own.
export const flowSettingsInput = (repo: PersonaRepo, flow: string) =>
  Option.match(Record.get(repo.flows, flow), {
    onNone: () => repo.shared,
    onSome: (found) =>
      mergeSettings(
        mergeSettings(repo.shared, oldRouting(found)),
        Option.getOrElse(Option.fromUndefinedOr(found.settings), () => ({})),
      ),
  });

// Decodes each flow's settings with the schema it declares, as each persona
// runs it: a setting the schema refuses fails the repo when it loads.
export const checkFlowSettings = (repo: EffectiveRepo, flows: ReadonlyMap<string, Flow>) =>
  Effect.forEach(
    [...flows].flatMap(([flowName, flow]) =>
      Option.toArray(
        Option.map(Option.fromUndefinedOr(flow.settings), (schema) => ({ flowName, schema })),
      ),
    ),
    ({ flowName, schema }) =>
      Effect.forEach(
        repo.personas,
        (own) =>
          Schema.decodeEffect(schema)(flowSettingsInput(own, flowName)).pipe(
            Effect.mapError(
              (issue) =>
                new ConfigError({
                  message: `${repo.settings.name}${asSuffix(own.persona)}: flows.${flowName}.settings: ${issue.message}`,
                }),
            ),
          ),
        { discard: true },
      ),
    { discard: true },
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
      const before = Option.fromUndefinedOr(merged[name]?.settings);
      const over = Option.fromUndefinedOr(settings.settings);
      merged[name] = { ...merged[name], ...settings };

      if (Option.isSome(earlier) && Option.isSome(later)) {
        merged[name] = { ...merged[name], agents: { ...earlier.value, ...later.value } };
      }

      // So are a flow's own settings, so a person can change one and keep the team's others.
      if (Option.isSome(before) && Option.isSome(over)) {
        merged[name] = { ...merged[name], settings: mergeSettings(before.value, over.value) };
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
  planNodes: file?.planNodes ?? DEFAULT_LIMITS.planNodes,
  planRounds: file?.planRounds ?? DEFAULT_LIMITS.planRounds,
  stackDepth: file?.stackDepth ?? DEFAULT_LIMITS.stackDepth,
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

// The engine still reads the reviewer pool (for a persona's reviewer seat),
// the board (for queued issues) and the label names (to release a cancelled
// run's claim) from Repo, until core's next major (ADR 0005): so a repo that
// moved them to its shared settings gives them there, over the old keys'
// labels, and the engine and the SDK's blocks agree on them. One the
// schema doesn't fit is the flows' to refuse, when they decode their settings.
const sharedSetting = <A, I>(repo: RepoConfigFile, key: string, schema: Schema.Codec<A, I>) =>
  Option.flatMap(Option.fromUndefinedOr(repo.settings?.[key]), (value) =>
    Result.getSuccess(Schema.decodeUnknownResult(schema)(value)),
  );

// Merges the layers for one persona of a repo. `configDir` is where its
// .chernabog/ was read from; `env` is the extra environment its commands run
// with; `defaultBranch` is the repo's default branch, the integration base
// when config.yaml's deprecated baseBranch doesn't name one.
const mergePersona = (
  machine: MachineConfig,
  enrolled: EnrolledRepo,
  repo: RepoConfigFile,
  persona: Persona,
  configDir: string,
  env: Environment,
  defaultBranch: string,
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
      baseBranch: repo.baseBranch ?? defaultBranch,
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
      labels: {
        ...DEFAULT_LABELS,
        ...repo.labels,
        ...Option.getOrElse(sharedSetting(repo, "labels", LabelsFile), () => ({})),
      },
      install: Option.flatten(Option.fromUndefinedOr(repo.install)),
      localGate: repo.localGate ?? [],
      humanOnly: [...machine.humanOnly, ...(repo.humanOnly ?? [])],
      humanOnlyPaths: repo.humanOnlyPaths ?? [".github/**"],
      notes: repo.notes ?? [],
      board: Option.orElse(Option.flatten(Option.fromUndefinedOr(repo.board)), () =>
        Option.flatten(sharedSetting(repo, "board", Schema.OptionFromNullOr(Board))),
      ),
      reviewTrigger: Option.none(),
      ...Option.match(
        Option.orElse(Option.fromUndefinedOr(repo.reviewers), () =>
          sharedSetting(repo, "reviewers", Strings),
        ),
        {
          onNone: () => ({}),
          onSome: (reviewers) => ({ reviewers }),
        },
      ),
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
      shared: repo.settings ?? {},
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
  defaultBranch = "main",
) =>
  Effect.gen(function* () {
    const [first, ...rest] = yield* personasOf(machine, enrolled);

    const merge = (persona: Persona) =>
      mergePersona(machine, enrolled, repo, persona, configDir, env, defaultBranch);

    const head = yield* merge(first);
    const tail = yield* Effect.forEach(rest, merge);

    const eventTickMin = Option.getOrElse(
      Option.flatMap(Option.fromUndefinedOr(repo.limits?.eventTickMin), parseDuration),
      () => DEFAULT_EVENT_TICK_MIN,
    );

    const validityEvery = Option.getOrElse(
      Option.flatMap(Option.fromUndefinedOr(repo.limits?.validityEvery), parseDuration),
      () => DEFAULT_VALIDITY_EVERY,
    );

    const duration = (text: Option.Option<string>, fallback: Duration.Duration) =>
      Option.getOrElse(Option.flatMap(text, parseDuration), () => fallback);

    const leases: LeaseLimits = {
      ttl: duration(Option.fromUndefinedOr(repo.limits?.leaseTtl), DEFAULT_LEASE_LIMITS.ttl),
      parkedTtl: duration(
        Option.fromUndefinedOr(repo.limits?.parkedLeaseTtl),
        DEFAULT_LEASE_LIMITS.parkedTtl,
      ),
      renewEvery: duration(
        Option.fromUndefinedOr(repo.limits?.leaseRenewEvery),
        DEFAULT_LEASE_LIMITS.renewEvery,
      ),
    };

    return {
      settings: head.settings,
      personas: [head, ...tail],
      eventTickMin,
      validityEvery,
      leases,
    } satisfies EffectiveRepo;
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
// A .chernabog/ this binary can't run is refused first. Past that, a key
// this binary doesn't know is a typo or a newer chernabog's key, and either
// one may be a rule the repo counts on, so it fails the repo instead of being
// dropped.
// `overrides` reads recipe packages from directories of their own, as
// `chernabog rehearse --package` does.
export const loadRepo = (
  machine: MachineConfig,
  enrolled: EnrolledRepo,
  configDir: string,
  overrides: PackageOverrides = new Map(),
) =>
  Effect.gen(function* () {
    yield* checkRunnable(configDir, overrides);
    const repo = yield* readYaml(RepoConfigFile, `${configDir}/config.yaml`, true);

    return yield* mergeRepoConfig(
      machine,
      enrolled,
      repo,
      configDir,
      yield* repoEnvironment(enrolled.path),
      yield* knownDefaultBranch(enrolled.path),
    );
  });

// Edits machine config in place, keeping the file's comments. `edit` changes
// the document, given the file as it decodes now, and says what it did. It
// fails FileBusy when another process holds the file too long.
export const editMachineConfig = <A, E, R>(
  edit: (document: YAML.Document, current: MachineConfigFile) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const file = homePaths(home.root).machineConfig;

    const platform = <B, F extends { readonly message: string }>(effect: Effect.Effect<B, F>) =>
      effect.pipe(Effect.mapError((error) => new ConfigError({ message: error.message })));

    yield* platform(fs.makeDirectory(home.root, { recursive: true }));

    // Under machine config's lock, and again from the top if an editor saved it meanwhile.
    return yield* updateFile(fs, file, "editing machine config", (text) =>
      Effect.gen(function* () {
        const document = Option.match(text, {
          onNone: () => new YAML.Document({}),
          onSome: (found) => YAML.parseDocument(found),
        });

        const decoded = yield* Schema.decodeUnknownEffect(MachineConfigFile)(
          document.toJS() ?? {},
        ).pipe(
          Effect.mapError((issue) => new ConfigError({ message: `${file}: ${issue.message}` })),
        );

        // Paths as the rest of chernabog sees them; the document keeps them as written.
        const current = {
          ...decoded,
          repos: (decoded.repos ?? []).map((entry) => ({
            ...entry,
            path: expandHome(entry.path, home.user),
          })),
        };

        const result = yield* edit(document, current);

        return [result, Option.some(document.toString())] as const;
      }),
    ).pipe(
      // FileBusy stays itself, so a caller can say to try again.
      Effect.mapError((error) => {
        if (PlatformError.isPlatformError(error)) {
          return new ConfigError({ message: error.message });
        }

        return error;
      }),
    );
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
