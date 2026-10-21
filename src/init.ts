// `chernabog init` scaffolds .chernabog/ in a repo, with the default flows
// built from today's logic; `chernabog enroll` adds the repo to this
// machine's config.

import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { ConfigError } from './config.ts';
import { execOk } from './Exec.ts';
import { checkConfigVersion, flowPackageText, withBundledPins } from './flow-deps.ts';
import { viewerLogin } from './GitHubApi.ts';
import { flowNames } from './loader.ts';
import { type EnrolledRepo, enrollInMachineConfig, type MachineConfig, MachineConfigFile, namesRunners, readYaml, RepoConfigFile, setRepoFlows, teamOff } from './repo-config.ts';
import { TEMPLATES } from './templates.ts';

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
});

// Every file init writes, by path under .chernabog/.
export const scaffoldFiles = () => ({ ...TEMPLATES, ...schemaFiles(), 'package.json': flowPackageText() });

export const machineSchema = () => jsonSchemaOf(MachineConfigFile);

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

// Each gitignore entry init adds, unless one of the lines it lists is there already.
const IGNORED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
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
    const { 'package.json': packageText, ...files } = scaffoldFiles();
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

// owner/name of the checkout's origin.
export const slugOf = (root: string) =>
  Effect.gen(function* () {
    const remote = yield* execOk('git', ['-C', root, 'remote', 'get-url', 'origin']);

    return yield* Effect.fromOption(slugFromRemote(remote)).pipe(Effect.mapError(() => new ConfigError({ message: `${root}: origin (${remote.trim()}) is not a GitHub repo` })));
  });

// The machine config entry for the repo a checkout is in, before it's written.
export const enrolmentOf = (path: string, enrolment: Enrolment) =>
  Effect.gen(function* () {
    const root = yield* repoRoot(path);
    const slug = yield* slugOf(root);
    const head = yield* execOk('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).pipe(Effect.orElseSucceed(() => 'origin/main'));
    let repo: EnrolledRepo = { path: root, repo: slug, baseBranch: head.trim().replace(/^origin\//, '') };

    if (Option.isSome(enrolment.name)) repo = { ...repo, name: enrolment.name.value };

    if (Option.isSome(enrolment.account)) repo = { ...repo, account: enrolment.account.value };

    return repo;
  });

export const enroll = (path: string, enrolment: Enrolment) =>
  Effect.gen(function* () {
    const repo = yield* enrolmentOf(path, enrolment);
    const action = yield* enrollInMachineConfig(repo);

    return { repo, action };
  });

// Entries for a repo whose checkout is gone: what chernabog init at its new
// place offers to point there.
export const movedEntries = (machine: MachineConfig, slug: string, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const moved: Array<EnrolledRepo> = [];

    for (const entry of machine.repos.filter((candidate) => candidate.repo === slug && candidate.path !== root)) {
      if (!(yield* fs.exists(entry.path).pipe(Effect.orElseSucceed(() => true)))) moved.push(entry);
    }

    return moved;
  });

// Points an entry at its checkout's new place, keeping every setting.
export const repoint = (entry: EnrolledRepo, root: string) =>
  enrollInMachineConfig({ repo: entry.repo, path: root, ...Option.match(Option.fromUndefinedOr(entry.name), { onNone: () => ({}), onSome: (name) => ({ name }) }) });

// The GitHub logins the team's runners are matched against for a repo: its
// personas, else machine config's, else whoever this machine is on GitHub.
export const loginsFor = (machine: MachineConfig, entry: Option.Option<EnrolledRepo>) => {
  const named = Option.getOrElse(Option.map(Option.flatMap(entry, (found) => Option.fromUndefinedOr(found.personas)), Object.keys), () => machine.github);

  if (named.length > 0) return Effect.succeed(named);

  return Effect.map(Effect.option(viewerLogin), Option.toArray);
};

export type FlowChoice = { readonly name: string; readonly enabled: boolean };

// A flow as it stands for this repo: whether it runs, whether the team's
// config.yaml offers it here, and why not when it doesn't.
export type FlowStanding = FlowChoice & { readonly teamDefault: boolean; readonly teamOff: Option.Option<string> };

// The checkout's flows, and whether each runs: as the repo's entry in machine
// config lists them, else as the team offers them: flows.<flow>.enabled, then
// whether one of `logins` is a runner. `logins` is looked up only when the
// team names runners.
export const flowChoices = <R>(root: string, listed: Option.Option<ReadonlyArray<string>>, logins: Effect.Effect<ReadonlyArray<string>, never, R>) =>
  Effect.gen(function* () {
    const names = yield* flowNames(`${root}/.chernabog`);
    const repo = yield* readYaml(RepoConfigFile, `${root}/.chernabog/config.yaml`);
    let self: ReadonlyArray<string> = [];

    if (namesRunners(repo, names)) self = yield* logins;

    return names.map((name): FlowStanding => {
      const off = teamOff(repo, name, self);

      return { name, enabled: Option.getOrElse(Option.map(listed, (flows) => flows.includes(name)), () => Option.isNone(off)), teamDefault: Option.isNone(off), teamOff: off };
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

// Lists the chosen flows on the repo's entry in machine config, for every
// persona that doesn't list its own, and leaves the rest off.
export const chooseFlows = (root: string, repo: EnrolledRepo, chosen: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const names = yield* checkFlowNames(root, chosen);
    const choices = names.map((name): FlowChoice => ({ name, enabled: chosen.includes(name) }));

    yield* setRepoFlows(repo, chosen);

    return choices;
  });
