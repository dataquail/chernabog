import { fillTemplate, globToRegExp, parseJson, pathsMatching } from '@chernabog/sdk';
import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';

import { BUNDLED_PACKAGES } from '../src/flow-deps.ts';
import { scaffold, scaffoldFiles, slugFromRemote } from '../src/init.ts';
import { DEFAULT_LIMITS, type EnrolledRepo, LocalConfigFile, MachineConfigFile, mergeRepoConfig, normalizeMachineConfig, RepoConfigFile } from '../src/repo-config.ts';
import { effect } from './effect-test.ts';

const machine = normalizeMachineConfig(
  Schema.decodeSync(MachineConfigFile)({
    accounts: { work: {}, personal: { configDir: '~/.claude-personal', expectedEmail: 'dev@example.com', agent: 'codex' } },
    concurrency: 2,
    humanOnly: ['a machine-wide limit'],
    repos: [{ path: '~/code/demo', repo: 'dataquail/demo', account: 'personal' }],
  }),
  '/Users/dev',
);

const enrolled: EnrolledRepo = { path: '/Users/dev/code/demo', repo: 'dataquail/demo', account: 'personal' };

const merge = (repo: typeof RepoConfigFile.Encoded, local: typeof LocalConfigFile.Encoded, onto: EnrolledRepo = enrolled) =>
  Effect.gen(function* () {
    const files = { repo: yield* Schema.decodeEffect(RepoConfigFile)(repo), local: yield* Schema.decodeEffect(LocalConfigFile)(local) };

    return yield* mergeRepoConfig(machine, onto, files, '/snapshot/.chernabog', {});
  });

const flowSettings = (merged: Effect.Success<ReturnType<typeof merge>>, flow: string) => Record.get(merged.flows, flow);

describe('config layers', () => {
  test('machine config expands home and defaults the account to the first one', () => {
    expect(machine.repos.map((repo) => repo.path)).toEqual(['/Users/dev/code/demo']);
    expect(machine.accounts.find((account) => account.name === 'personal')?.configDir).toEqual(Option.some('/Users/dev/.claude-personal'));
  });

  effect(
    "the person's local.yaml overrides the repo's config key by key",
    () => Effect.gen(function* () {
      const merged = yield* merge(
        { schedule: '0 * * * *', localGate: ['pnpm test'], flows: { review: { schedule: '30 * * * *', concurrency: 5 } } },
        { schedule: '15 * * * *', flows: { review: { enabled: false } } },
      );

      expect(merged.schedule).toEqual(Option.some('15 * * * *'));
      expect(flowSettings(merged, 'review')).toEqual(Option.some({ schedule: '30 * * * *', enabled: false, concurrency: 2 }));
      expect(merged.settings.localGate).toEqual(['pnpm test']);
      expect(merged.settings.humanOnly).toEqual(['a machine-wide limit']);
      expect(merged.settings.limits).toEqual(DEFAULT_LIMITS);
      expect(merged.settings.labels.eligible).toBe('auto:eligible');
    }),
  );

  effect(
    "the agent comes from local.yaml, then the repo, then the account's own agent",
    () => Effect.gen(function* () {
      const agentOf = (repo: typeof RepoConfigFile.Encoded, local: typeof LocalConfigFile.Encoded) => merge(repo, local).pipe(Effect.map((merged) => merged.settings.agent));
      expect(yield* agentOf({ agent: 'opencode' }, { agent: 'claude' })).toBe('claude');
      expect(yield* agentOf({ agent: 'opencode' }, {})).toBe('opencode');
      expect(yield* agentOf({}, {})).toBe('codex');
    }),
  );

  effect(
    'each agent runs under an account of its own',
    () => Effect.gen(function* () {
      const merged = yield* merge({}, {});
      const accountFor = (agent: string) => Option.map(Record.get(merged.settings.agentAccounts, agent), (account) => account.name);
      expect(accountFor('codex')).toEqual(Option.some('personal'));
      expect(accountFor('claude')).toEqual(Option.some('work'));
      expect(merged.settings.account.name).toBe('personal');
    }),
  );

  effect(
    'a repo cannot raise concurrency past the machine limit',
    () => Effect.gen(function* () {
      const merged = yield* merge({ flows: { implement: { concurrency: 10 } } }, {});
      expect(Option.map(flowSettings(merged, 'implement'), (settings) => settings.concurrency)).toEqual(Option.some(2));
    }),
  );

  effect(
    'an unknown account is refused',
    () => Effect.gen(function* () {
      const error = yield* Effect.flip(merge({}, {}, { ...enrolled, account: 'other' }));
      expect(error.message).toContain('"other" is not one of work, personal');
    }),
  );

  describe('the launcher', () => {
    const machineWith = (extra: Partial<typeof MachineConfigFile.Encoded>) =>
      normalizeMachineConfig(Schema.decodeSync(MachineConfigFile)({ repos: [{ path: '~/code/demo', repo: 'dataquail/demo' }], ...extra }), '/Users/dev');

    const resolve = (repo: typeof RepoConfigFile.Encoded, local: typeof LocalConfigFile.Encoded, extra: Partial<typeof MachineConfigFile.Encoded> = {}) =>
      Effect.gen(function* () {
        const files = { repo: yield* Schema.decodeEffect(RepoConfigFile)(repo), local: yield* Schema.decodeEffect(LocalConfigFile)(local) };
        const merged = yield* mergeRepoConfig(machineWith(extra), { path: '/Users/dev/code/demo', repo: 'dataquail/demo' }, files, '/snapshot/.chernabog', {});

        return merged.settings.launcher;
      });

    const chosen = (repo: typeof RepoConfigFile.Encoded, local: typeof LocalConfigFile.Encoded, extra: Partial<typeof MachineConfigFile.Encoded> = {}) =>
      Effect.map(resolve(repo, local, extra), (launcher) => `${launcher.name} (${launcher.from})`);

    effect(
      "comes from local.yaml, then machine config, then the repo's default, then headless",
      () => Effect.gen(function* () {
        expect(yield* chosen({ launcher: 'tmux' }, { launcher: 'orca' }, { launcher: 'tmux' })).toBe('orca (local.yaml)');
        expect(yield* chosen({ launcher: 'tmux' }, {}, { launcher: 'orca' })).toBe('orca (machine config)');
        expect(yield* chosen({ launcher: 'tmux' }, {})).toBe('tmux (repo config)');
        expect(yield* chosen({}, {})).toBe('headless (default)');
      }),
    );

    effect(
      "fails closed outside the repo's allowedLaunchers, naming the layer that chose it",
      () => Effect.gen(function* () {
        const error = yield* Effect.flip(resolve({ launcher: 'orca', allowedLaunchers: ['orca', 'headless'] }, {}, { launcher: 'tmux' }));
        expect(error.message).toBe(`launcher "tmux" (from machine config) isn't allowed by demo's config: allowedLaunchers is orca, headless`);
        expect(yield* chosen({ launcher: 'orca', allowedLaunchers: ['orca', 'tmux'] }, { launcher: 'tmux' })).toBe('tmux (local.yaml)');
        const unset = yield* Effect.flip(resolve({ allowedLaunchers: ['orca'] }, {}));
        expect(unset.message).toContain('launcher "headless" (from default)');
      }),
    );

    effect(
      'an unknown launcher is refused, listing the known ones',
      () => Effect.gen(function* () {
        const error = yield* Effect.flip(resolve({}, { launcher: 'screen' }, { launchers: { mine: { start: ['x'], close: ['y'] } } }));
        expect(error.message).toBe('unknown launcher "screen" (from local.yaml); known launchers: headless, orca, tmux, mine');
      }),
    );

    effect(
      'a launcher of your own comes from machine config, with its commands',
      () => Effect.gen(function* () {
        const launcher = yield* resolve({}, {}, { launcher: 'mine', launchers: { mine: { start: ['wezterm', 'cli', 'spawn', '--', 'sh', '-c', '{command}'], close: ['true'] } } });
        expect(launcher.name).toBe('mine');
        expect(Option.map(launcher.custom, (commands) => commands.start[0])).toEqual(Option.some('wezterm'));
      }),
    );

    test('launcher commands in a repo or local.yaml are refused', () => {
      const launchers = { mine: { start: ['curl', 'evil.sh'], close: ['true'] } };
      const repo = Schema.decodeUnknownResult(RepoConfigFile)({ launchers });
      const local = Schema.decodeUnknownResult(LocalConfigFile)({ launchers });
      expect(Option.map(Result.getFailure(repo), (issue) => issue.message)).toEqual(Option.some(expect.stringMatching(/only be defined in machine config/)));
      expect(Result.isFailure(local)).toBe(true);
    });
  });

  test('the scaffolded config.yaml is valid repo config', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(RepoConfigFile)(YAML.parse(scaffoldFiles()['config.yaml'])))).toBe(true);
  });

  test('a duration that is not one is refused', () => {
    const decoded = Schema.decodeResult(RepoConfigFile)({ limits: { staleAfter: 'soonish' } });
    expect(Option.map(Result.getFailure(decoded), (issue) => issue.message)).toEqual(Option.some(expect.stringMatching(/not a duration/)));
  });
});

describe('init', () => {
  effect(
    'scaffolds .chernabog/ without overwriting, and gitignores local.yaml once',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      yield* fs.writeFileString(`${repo}/.gitignore`, 'node_modules/');
      const first = yield* scaffold(repo);
      expect(first).toContain('.chernabog/flows/implement.ts');
      expect(yield* fs.exists(`${repo}/.chernabog/config.schema.json`)).toBe(true);
      yield* fs.writeFileString(`${repo}/.chernabog/config.yaml`, 'baseBranch: develop\n');
      expect(yield* scaffold(repo)).toEqual([]);
      expect(yield* fs.readFileString(`${repo}/.chernabog/config.yaml`)).toBe('baseBranch: develop\n');
      expect(yield* fs.readFileString(`${repo}/.gitignore`)).toBe('node_modules/\n.chernabog/local.yaml\n');
    }),
  );

  effect(
    'brings the generated schemas up to date, and only those',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      yield* scaffold(repo);
      yield* fs.writeFileString(`${repo}/.chernabog/config.schema.json`, '{}');
      yield* fs.writeFileString(`${repo}/.chernabog/config.yaml`, 'baseBranch: develop\n');
      expect(yield* scaffold(repo)).toEqual(['.chernabog/config.schema.json (updated)']);
      expect(yield* fs.readFileString(`${repo}/.chernabog/config.schema.json`)).toContain('allowedLaunchers');
      expect(yield* fs.readFileString(`${repo}/.chernabog/config.yaml`)).toBe('baseBranch: develop\n');
    }),
  );

  effect(
    'gitignores local.yaml and .chernabog/node_modules/ in a repo that ignores nothing yet',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      yield* scaffold(repo);
      expect(yield* fs.readFileString(`${repo}/.gitignore`)).toBe('.chernabog/local.yaml\n.chernabog/node_modules/\n');
    }),
  );

  effect(
    "pins the bundled SDK and effect in package.json, and brings only those pins up to date",
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      const path = `${repo}/.chernabog/package.json`;
      yield* scaffold(repo);
      expect(parseJson(yield* fs.readFileString(path))).toEqual(Option.some({ private: true, devDependencies: BUNDLED_PACKAGES }));

      yield* fs.writeFileString(path, '{ "name": "flows", "dependencies": { "effect": "4.0.0", "zod": "^3" }, "devDependencies": { "@chernabog/sdk": "0.0.1", "typescript": "5" } }');
      expect(yield* scaffold(repo)).toEqual(['.chernabog/package.json (pins updated)']);
      expect(parseJson(yield* fs.readFileString(path))).toEqual(
        Option.some({ name: 'flows', dependencies: { zod: '^3' }, devDependencies: { typescript: '5', ...BUNDLED_PACKAGES } }),
      );
      expect(yield* scaffold(repo)).toEqual([]);
    }),
  );

  test('the repo slug comes from an https or ssh origin', () => {
    expect(slugFromRemote('git@github.com:dataquail/goodbones.git\n')).toEqual(Option.some('dataquail/goodbones'));
    expect(slugFromRemote('https://github.com/dataquail/goodbones')).toEqual(Option.some('dataquail/goodbones'));
    expect(slugFromRemote('/tmp/origin.git')).toEqual(Option.none());
  });
});

describe('path rules and prompts', () => {
  test('globs match directories, nested files and exact names', () => {
    expect(pathsMatching(['.github/workflows/ci.yml', 'src/.github.ts', 'RELEASE.md', 'packages/a/package.json'], ['.github/**', 'RELEASE.md', '**/package.json'])).toEqual([
      '.github/workflows/ci.yml',
      'RELEASE.md',
      'packages/a/package.json',
    ]);
    expect(globToRegExp('.github/').test('.github/CODEOWNERS')).toBe(true);
    expect(globToRegExp('*.md').test('docs/a.md')).toBe(false);
  });

  test('prompt placeholders fill with values, and lists render as bullets', () => {
    expect(fillTemplate('#{{issue}}: {{ title }}\n{{notes}}\n{{empty}}\n{{unknown}}', { issue: 7, title: 'Fix', notes: ['a', 'b'], empty: [] })).toBe(
      '#7: Fix\n- a\n- b\n- none\n{{unknown}}',
    );
  });
});
