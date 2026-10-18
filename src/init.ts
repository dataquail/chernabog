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
import { type EnrolledRepo, enrollInMachineConfig, LocalConfigFile, MachineConfigFile, RepoConfigFile } from './repo-config.ts';
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

