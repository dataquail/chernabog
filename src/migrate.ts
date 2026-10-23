// Brings machine config up to date with each persona's settings living there
// (#50). Before, each person's flow choices lived in the checkout's
// .chernabog/local.yaml, and a repo's personas were a list. Now a repo's
// entry carries the defaults its personas inherit, and `personas` is a map of
// login to that persona's own choices. Runs before anything reads machine
// config, rewrites it in place, keeping its comments, and says what it changed.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { asSuffix, type Persona } from "./kernel/persona.value-object.ts";
import { ConfigError } from "./platform/config-error.ts";
import { updateFile } from "./platform/file-lock.ts";
import { flowNames } from "./platform/flow-loader.ts";
import { viewerLogin } from "./platform/github-api.ts";
import { expandHome, Home, homePaths } from "./platform/home.ts";
import { namesRunners, readYaml, RepoConfigFile, teamOff } from "./repo-config.ts";

// What .chernabog/local.yaml held, as written.
const LocalFile = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(Schema.String),
  activeHours: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  launcher: Schema.optionalKey(Schema.String),
  flows: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  ),
});

type LocalFile = typeof LocalFile.Type;

// The keys of local.yaml that move onto the repo's entry as they are.
const MOVED = ["enabled", "schedule", "activeHours", "agent", "launcher"] as const;

// The parts of a repo's entry the migration reads, as written.
const Entry = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  name: Schema.optionalKey(Schema.String),
  flows: Schema.optionalKey(Schema.Unknown),
  personas: Schema.optionalKey(Schema.Unknown),
});

// personas from before #50, a list of logins.
const PersonaList = Schema.Array(Schema.String);

const PersonaMap = Schema.Record(
  Schema.String,
  Schema.NullOr(Schema.Struct({ flows: Schema.optionalKey(Schema.Unknown) })),
);

type Entry = typeof Entry.Type;

const Machine = Schema.Struct({
  github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  repos: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

// Whether the entry lists flows anywhere: on itself, or on one of its personas.
const listsFlows = (entry: Entry) =>
  Predicate.isNotUndefined(entry.flows) ||
  Option.exists(Schema.decodeUnknownOption(PersonaMap)(entry.personas), (personas) =>
    Object.values(personas).some(
      (own) => Predicate.isNotNullish(own) && Predicate.isNotUndefined(own.flows),
    ),
  );

// The personas whose flows the entry lists: its own, else machine config's
// only login, else the implicit persona.
const personasOf = (
  logins: ReadonlyArray<string>,
  github: ReadonlyArray<string>,
): ReadonlyArray<Persona> => {
  if (logins.length > 0) {
    return logins.map(Option.some);
  }

  if (github.length === 1) {
    return [Option.some(github[0])];
  }

  return [Option.none()];
};

const localFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${path}/.chernabog/local.yaml`;

    if (!(yield* fs.exists(file))) {
      return Option.none<{ readonly file: string; readonly local: LocalFile }>();
    }

    const text = yield* fs.readFileString(file);

    const local = yield* Schema.decodeUnknownEffect(LocalFile)(YAML.parse(text) ?? {}).pipe(
      Effect.mapError((issue) => new ConfigError({ message: `${file}: ${issue.message}` })),
    );

    return Option.some({ file, local });
  });

// A flow's settings from local.yaml, which carry over to its entry; enabled
// is the choice itself, which listing the flow now makes.
const settingsOf = (local: LocalFile, flow: string) =>
  Record.remove(local.flows?.[flow] ?? {}, "enabled");

// Whether a flow ran as a login before: local.yaml's choice, else the team's
// flows.<flow>.enabled, else whether the login is one of its runners.
const ranAs = (
  team: RepoConfigFile,
  local: LocalFile,
  flow: string,
  login: Option.Option<string>,
) => {
  const own = local.flows?.[flow]?.enabled;

  if (Predicate.isBoolean(own)) {
    return own;
  }

  return Option.isNone(teamOff(team, flow, Option.toArray(login)));
};

const listed = (flows: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(flows.join(", "), (text) => text.length > 0),
    () => "none",
  );

// Lists the flows that ran in a checkout before, and moves its local.yaml
// onto the repo's entry. None when the checkout or its flows can't be read;
// they're listed on the first run that can.
const migrateChoices = (
  document: YAML.Document,
  index: number,
  entry: Entry,
  path: string,
  personas: ReadonlyArray<Persona>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = `${path}/.chernabog`;

    if (!(yield* fs.exists(configDir))) {
      return [];
    }

    const names = yield* flowNames(configDir);

    if (names.length === 0) {
      return [];
    }

    const team = yield* readYaml(RepoConfigFile, `${configDir}/config.yaml`);
    const found = yield* localFile(path);

    const local = Option.getOrElse(
      Option.map(found, (read) => read.local),
      (): LocalFile => ({}),
    );

    const lines: Array<string> = [];
    // Who the implicit persona is matters only for the team's runners.
    let self: ReadonlyArray<string> = [];

    if (personas.some(Option.isNone) && namesRunners(team, names)) {
      self = Option.toArray(yield* Effect.option(viewerLogin));
    }

    const login = (persona: Persona) => Option.orElse(persona, () => Arr.head(self));

    const ran = personas.map((persona) => ({
      persona,
      flows: names.filter((flow) => ranAs(team, local, flow, login(persona))),
    }));

    const flowsOf = (flows: ReadonlyArray<string>) =>
      document.createNode(Object.fromEntries(flows.map((flow) => [flow, settingsOf(local, flow)])));

    const same = ran.every((each) => each.flows.join(",") === ran[0].flows.join(","));

    if (same) {
      document.setIn(["repos", index, "flows"], flowsOf(ran[0].flows));
      lines.push(`${entry.repo}: listed the flows that ran here: ${listed(ran[0].flows)}`);
    } else {
      for (const { flows, persona } of ran) {
        for (const named of Option.toArray(persona)) {
          document.setIn(["repos", index, "personas", named, "flows"], flowsOf(flows));
        }

        lines.push(
          `${entry.repo}${asSuffix(persona)}: listed the flows that ran here: ${listed(flows)}`,
        );
      }
    }

    for (const { file } of Option.toArray(found)) {
      const moved = MOVED.filter(
        (key) => Predicate.isNotUndefined(local[key]) && !document.hasIn(["repos", index, key]),
      );

      for (const key of moved) {
        document.setIn(["repos", index, key], local[key]);
      }

      const what = Option.getOrElse(
        Option.map(
          Option.liftPredicate(moved, Arr.isReadonlyArrayNonEmpty),
          (keys) => `its ${keys.join(", ")} and flow choices`,
        ),
        () => "its flow choices",
      );

      lines.push(
        `${entry.repo}: moved ${what} from ${file} onto its entry in machine config; chernabog no longer reads local.yaml, so delete it`,
      );
    }

    return lines;
  });

// paused.json from before kept a paused repo by its name; a repo's records
// are kept by its slug now, as its entry in machine config is.
const PausedFile = Schema.fromJsonString(Schema.Array(Schema.String));

// What an update of a file found, and the text to replace it with, if any.
type Update<A> = readonly [A, Option.Option<string>];

// What migrating machine config said, and the repos' entries it read (none
// when the file doesn't parse).
type Migrated = {
  readonly lines: ReadonlyArray<string>;
  readonly entries: Option.Option<ReadonlyArray<Entry>>;
};

const migratePaused = (entries: ReadonlyArray<Entry>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = homePaths((yield* Home).root).paused;

    if (!(yield* fs.exists(file))) {
      return [];
    }

    return yield* updateFile(fs, file, "migrating paused.json", (text) =>
      Effect.gen(function* () {
        const unchanged: Update<ReadonlyArray<string>> = [[], Option.none()];
        const kept = Option.flatMap(text, Schema.decodeOption(PausedFile));

        // A name is never owner/name.
        const byName = Option.getOrElse(kept, (): ReadonlyArray<string> => []).filter(
          (key) => !key.includes("/"),
        );

        if (Option.isNone(kept) || byName.length === 0) {
          return unchanged;
        }

        const slugOf = (name: string) =>
          Option.map(
            Arr.findFirst(
              entries,
              (entry) => (entry.name ?? entry.repo.split("/").at(-1)) === name,
            ),
            (entry) => entry.repo,
          );

        const slugs = Arr.dedupe([
          ...kept.value.filter((key) => key.includes("/")),
          ...byName.flatMap((name) => Option.toArray(slugOf(name))),
        ]);

        const moved = byName.map(
          (name) => `${name} → ${Option.getOrElse(slugOf(name), () => "not enrolled, dropped")}`,
        );

        return [
          [`paused.json now keeps paused repos by owner/name: ${moved.join(", ")}`],
          Option.some(`${yield* Schema.encodeEffect(PausedFile)(Arr.sort(slugs, Order.String))}\n`),
        ] as const;
      }),
    );
  });

// What migrating machine config's text would change: the lines saying what,
// the repos' entries (none when the file doesn't parse), and the text to
// write, none when it's up to date.
const migrateText = (text: Option.Option<string>, user: string) =>
  Effect.gen(function* () {
    const untouched: Update<Migrated> = [{ lines: [], entries: Option.none() }, Option.none()];

    const document = YAML.parseDocument(Option.getOrElse(text, () => ""));

    // A file that doesn't parse is loadMachineConfig's to report.
    if (document.errors.length > 0) {
      return untouched;
    }

    const machine = Schema.decodeUnknownOption(Machine)(document.toJS() ?? {});

    if (Option.isNone(machine)) {
      return untouched;
    }

    const github = Object.keys(machine.value.github ?? {});
    const lines: Array<string> = [];

    for (const [index, raw] of (machine.value.repos ?? []).entries()) {
      const decoded = Schema.decodeUnknownOption(Entry)(raw);

      if (Option.isNone(decoded)) {
        continue;
      }

      const entry = decoded.value;

      let logins = Option.getOrElse(
        Option.map(Schema.decodeUnknownOption(PersonaMap)(entry.personas), Object.keys),
        (): ReadonlyArray<string> => [],
      );

      const list = Schema.decodeUnknownOption(PersonaList)(entry.personas);

      if (Option.isSome(list)) {
        logins = Arr.dedupe(list.value);
        document.setIn(
          ["repos", index, "personas"],
          document.createNode(Object.fromEntries(logins.map((login) => [login, {}]))),
        );
        lines.push(
          `${entry.repo}: personas is now a map of login to that persona's own settings: ${logins.join(", ")}`,
        );
      }

      if (listsFlows(entry)) {
        continue;
      }

      for (const line of yield* migrateChoices(
        document,
        index,
        entry,
        expandHome(entry.path, user),
        personasOf(logins, github),
      )) {
        lines.push(line);
      }
    }

    const entries = (machine.value.repos ?? []).flatMap((raw) =>
      Option.toArray(Schema.decodeUnknownOption(Entry)(raw)),
    );

    const update: Update<Migrated> = [
      { lines, entries: Option.some(entries) },
      Option.liftPredicate(document.toString(), () => lines.length > 0),
    ];

    return update;
  });

// Rewrites machine config, and returns what it changed: nothing when it's up
// to date. It looks first without machine config's lock, since it's usually
// up to date, and takes the lock only to change it.
export const migrateMachineConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Home;
  const file = homePaths(home.root).machineConfig;

  if (!(yield* fs.exists(file))) {
    return [];
  }

  const [looked, change] = yield* migrateText(
    Option.some(yield* fs.readFileString(file)),
    home.user,
  );

  const migrated = yield* Option.match(change, {
    onNone: () => Effect.succeed(looked),
    onSome: () =>
      updateFile(fs, file, "migrating machine config", (text) => migrateText(text, home.user)),
  });

  return [
    ...migrated.lines,
    ...(yield* Option.match(migrated.entries, {
      onNone: () => Effect.succeed([]),
      onSome: migratePaused,
    })),
  ];
}).pipe(
  Effect.catchTags({
    PlatformError: (error) => Effect.fail(new ConfigError({ message: error.message })),
    FileBusy: (error) => Effect.fail(new ConfigError({ message: error.message })),
  }),
);
