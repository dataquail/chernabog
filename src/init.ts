// `chernabog init` scaffolds .chernabog/ in a repo, with the default flows
// built from today's logic; `chernabog enroll` adds the repo to this
// machine's config.

import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';

import { ConfigError } from './config.ts';
import { execOk } from './Exec.ts';
import { checkConfigVersion, flowPackageText, withBundledPins } from './flow-deps.ts';
import { flowNames } from './loader.ts';
import { type EnrolledRepo, enrollInMachineConfig, FLOW_TURNED_OFF, LocalConfigFile, MachineConfigFile, notARunner, readYaml, RepoConfigFile } from './repo-config.ts';
import { TEMPLATES } from './templates.ts';

const LOCAL_TEMPLATE = `# yaml-language-server: $schema=./local.schema.json
#
# Your own settings for this repo: when Chernabog runs here and with which
# agent. Gitignored, so they never reach the team.

enabled: true
# schedule: "17 * * * *"
# activeHours: "09:00-18:00"
# agent: claude
# launcher: orca
# Which flows run here: chernabog enroll asks, and records them under flows.
# flows:
#   review:
#     enabled: false
`;

const JsonText = Schema.fromJsonString(Schema.Json, { space: 2 });

// A config file's JSON Schema, for editor autocomplete.
export const jsonSchemaOf = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);
  const json = Schema.decodeUnknownSync(Schema.Json)({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...document.schema, $defs: document.definitions });

  return `${Schema.encodeSync(JsonText)(json)}\n`;
};

// Generated from the config schemas, so init rewrites them to pick up new keys.
export const schemaFiles = () => ({
  'config.schema.json': jsonSchemaOf(RepoConfigFile),
  'local.schema.json': jsonSchemaOf(LocalConfigFile),
});

// Every file init writes, by path under .chernabog/.
export const scaffoldFiles = () => ({ ...TEMPLATES, ...schemaFiles(), 'package.json': flowPackageText() });

export const machineSchema = () => jsonSchemaOf(MachineConfigFile);

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

// Each gitignore entry init adds, unless one of the lines it lists is there already.
const IGNORED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['.chernabog/local.yaml', []],
  ['.chernabog/node_modules/', ['node_modules', 'node_modules/']],
];

// Writes the scaffold, never overwriting a file that is already there, except
// the generated schemas, which are brought up to date, and package.json's pins
// of the bundled packages, which are moved to this binary's versions. When
// either changes, the repo now relies on this binary, so its engines.chernabog
// floor rises to it. A binary older than the floor refuses, rather than move
// the repo back.
export const scaffold = (repoPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const written: Array<string> = [];
    const generated = schemaFiles();
    const { 'package.json': packageText, ...files } = { ...scaffoldFiles(), 'local.yaml': LOCAL_TEMPLATE };
    const manifestPath = `${repoPath}/.chernabog/package.json`;

    yield* checkConfigVersion(`${repoPath}/.chernabog`);

    for (const [relative, content] of Object.entries(files)) {
      const path = `${repoPath}/.chernabog/${relative}`;

      if (!(yield* fs.exists(path))) {
        yield* fs.makeDirectory(directoryOf(path), { recursive: true });
        yield* fs.writeFileString(path, content);
        written.push(`.chernabog/${relative}`);
      } else if (relative in generated && (yield* fs.readFileString(path)) !== content) {
        yield* fs.writeFileString(path, content);
        written.push(`.chernabog/${relative} (updated)`);
      }
    }

    if (!(yield* fs.exists(manifestPath))) {
      yield* fs.writeFileString(manifestPath, packageText);
      written.push('.chernabog/package.json');
    } else {
      const schemasUpdated = written.some((entry) => entry.endsWith('(updated)'));

      for (const pinned of Option.toArray(yield* withBundledPins(yield* fs.readFileString(manifestPath), schemasUpdated))) {
        yield* fs.writeFileString(manifestPath, pinned);
        written.push('.chernabog/package.json (pins updated)');
      }
    }

    const gitignore = `${repoPath}/.gitignore`;
    let ignored = '';

    if (yield* fs.exists(gitignore)) ignored = yield* fs.readFileString(gitignore);

    const lines = ignored.split('\n').map((line) => line.trim());

    const missing = IGNORED.flatMap(([entry, covering]) => {
      if ([entry, ...covering].some((line) => lines.includes(line))) return [];

      return [entry];
    });

    if (missing.length > 0) {
      let separator = '\n';

      if (ignored.length === 0 || ignored.endsWith('\n')) separator = '';

      yield* fs.writeFileString(gitignore, `${separator}${missing.join('\n')}\n`, { flag: 'a' });
      written.push(`.gitignore (+ ${missing.join(', ')})`);
    }

    return written;
  }).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new ConfigError({ message: error.message }))));

// owner/name of the repo's origin remote, from an https or ssh URL.
export const slugFromRemote = (url: string) => Option.map(Option.fromNullishOr(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())), (match) => match[1]);

export const repoRoot = (path: string) => execOk('git', ['-C', path, 'rev-parse', '--show-toplevel']).pipe(Effect.map((root) => root.trim()));

export type Enrolment = { readonly account: Option.Option<string>; readonly name: Option.Option<string> };

export const enroll = (path: string, enrolment: Enrolment) =>
  Effect.gen(function* () {
    const root = yield* repoRoot(path);
    const remote = yield* execOk('git', ['-C', root, 'remote', 'get-url', 'origin']);
    const slug = slugFromRemote(remote);

    if (Option.isNone(slug)) return yield* new ConfigError({ message: `${root}: origin (${remote.trim()}) is not a GitHub repo` });

    const head = yield* execOk('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).pipe(Effect.orElseSucceed(() => 'origin/main'));
    let repo: EnrolledRepo = { path: root, repo: slug.value, baseBranch: head.trim().replace(/^origin\//, '') };

    if (Option.isSome(enrolment.name)) repo = { ...repo, name: enrolment.name.value };

    if (Option.isSome(enrolment.account)) repo = { ...repo, account: enrolment.account.value };

    const action = yield* enrollInMachineConfig(repo);

    return { repo, action };
  });


export type FlowChoice = { readonly name: string; readonly enabled: boolean };

// A flow as it stands for this person: whether it runs, whether the team's
// config.yaml has it run here, and why not when it doesn't.
export type FlowStanding = FlowChoice & { readonly teamDefault: boolean; readonly teamOff: Option.Option<string> };

// The checkout's flows, and whether each runs for this person now: their
// local.yaml's choice, else the team's: flows.<flow>.enabled, then the
// runners. `login` is this machine's GitHub login, looked up only when the
// team names runners.
export const flowChoices = <R>(root: string, login: Effect.Effect<Option.Option<string>, never, R>) =>
  Effect.gen(function* () {
    const names = yield* flowNames(`${root}/.chernabog`);
    const repo = yield* readYaml(RepoConfigFile, `${root}/.chernabog/config.yaml`);
    const local = yield* readYaml(LocalConfigFile, `${root}/.chernabog/local.yaml`);
    const runnersOf = (name: string) => Option.orElse(Option.fromUndefinedOr(repo.flows?.[name]?.runners), () => Option.fromUndefinedOr(repo.runners));
    let self = Option.none<string>();

    if (names.some((name) => Option.isSome(runnersOf(name)))) self = yield* login;

    return names.map((name): FlowStanding => {
      const teamOff = Option.orElse(
        Option.liftPredicate(FLOW_TURNED_OFF, () => repo.flows?.[name]?.enabled === false),
        () => Option.flatMap(runnersOf(name), (runners) => notARunner(runners, self)),
      );

      return { name, enabled: local.flows?.[name]?.enabled ?? Option.isNone(teamOff), teamDefault: Option.isNone(teamOff), teamOff };
    });
  });

// Fails on a name that isn't one of the checkout's flows; else, all their names.
export const checkFlowNames = (root: string, chosen: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const names = yield* flowNames(`${root}/.chernabog`);
    const unknown = chosen.filter((name) => !names.includes(name));

    if (unknown.length > 0) return yield* new ConfigError({ message: `no flow named ${unknown.join(', ')} in .chernabog/flows/ (it has: ${names.join(', ')})` });

    return names;
  });

// Writes the template local.yaml when the person has none yet.
export const ensureLocalConfig = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${root}/.chernabog/local.yaml`;

    if (!(yield* fs.exists(`${root}/.chernabog`)) || (yield* fs.exists(path))) return false;

    yield* fs.writeFileString(path, LOCAL_TEMPLATE);

    return true;
  }).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new ConfigError({ message: error.message }))));

// Drops a map from local.yaml once nothing is left in it.
const pruneEmpty = (document: YAML.Document, path: ReadonlyArray<string>) => {
  const node = document.getIn(path);

  if (YAML.isMap(node) && node.items.length === 0) document.deleteIn(path);
};

// Records each choice in local.yaml as flows.<flow>.enabled, keeping its
// comments, but only where it differs from the team's: a choice the team
// already makes is left to the team, so a later change to its runners or
// flows.<flow>.enabled still reaches this person.
export const writeFlowChoices = <R>(root: string, choices: ReadonlyArray<FlowChoice>, login: Effect.Effect<Option.Option<string>, never, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${root}/.chernabog/local.yaml`;
    const standing = yield* flowChoices(root, login);

    yield* ensureLocalConfig(root);
    const document = YAML.parseDocument(yield* fs.readFileString(path));

    for (const { enabled, name } of choices) {
      const teamDefault = Option.getOrElse(Option.map(Arr.findFirst(standing, (flow) => flow.name === name), (flow) => flow.teamDefault), () => true);

      if (enabled !== teamDefault) {
        document.setIn(['flows', name, 'enabled'], enabled);
        continue;
      }

      if (!document.hasIn(['flows', name, 'enabled'])) continue;

      document.deleteIn(['flows', name, 'enabled']);
      pruneEmpty(document, ['flows', name]);
      pruneEmpty(document, ['flows']);
    }

    yield* fs.writeFileString(path, document.toString());
  }).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new ConfigError({ message: error.message }))));

// Turns the chosen flows on and every other one off, over the team's choice
// where they differ: a flow the team turns off still runs for a person who chose it.
export const chooseFlows = <R>(root: string, chosen: ReadonlyArray<string>, login: Effect.Effect<Option.Option<string>, never, R>) =>
  Effect.gen(function* () {
    const names = yield* checkFlowNames(root, chosen);
    const choices = names.map((name): FlowChoice => ({ name, enabled: chosen.includes(name) }));

    yield* writeFlowChoices(root, choices, login);

    return choices;
  });
