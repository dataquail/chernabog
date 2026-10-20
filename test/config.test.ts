import { defineFlow, fillTemplate, globToRegExp, parseJson, pathsMatching, printJson } from '@chernabog/sdk';
import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';

import { BUNDLED_PACKAGES, decodeManifest, requiredVersion } from '../src/flow-deps.ts';
import { chooseFlows, ensureLocalConfig, flowChoices, scaffold, scaffoldFiles, slugFromRemote } from '../src/init.ts';
import { DEFAULT_LIMITS, type EnrolledRepo, flowOff, loadRepo, LocalConfigFile, MachineConfigFile, mergeRepoConfig, needsLogin, normalizeMachineConfig, RepoConfigFile, routingOf } from '../src/repo-config.ts';
import { scheduleFor } from '../src/schedule.ts';
import { VERSION } from '../src/version.ts';
import { effect, effectAtHome } from './effect-test.ts';

const machine = normalizeMachineConfig(
  Schema.decodeSync(MachineConfigFile)({
    accounts: { work: {}, personal: { configDir: '~/.claude-personal', expectedEmail: 'dev@example.com', agent: 'codex' }, ci: { oauthTokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN', usageGate: 'none' } },
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

  test("an account's oauthTokenEnv names the variable its token comes from, never the token", () => {
    expect(machine.accounts.find((account) => account.name === 'ci')?.oauthTokenEnv).toEqual(Option.some('CLAUDE_CODE_OAUTH_TOKEN'));
    expect(machine.accounts.find((account) => account.name === 'work')?.oauthTokenEnv).toEqual(Option.none());
  });

  test('an account reads usage unless it opts out with usageGate: none', () => {
    expect(machine.accounts.find((account) => account.name === 'ci')?.usageGate).toBe('none');
    expect(machine.accounts.find((account) => account.name === 'work')?.usageGate).toBe('usage');
    expect(() => Schema.decodeUnknownSync(MachineConfigFile)({ accounts: { ci: { usageGate: 'off' } } })).toThrow();
  });

  effect(
    "the person's local.yaml overrides the repo's config key by key",
    () => Effect.gen(function* () {
      const merged = yield* merge(
        { schedule: '0 * * * *', localGate: ['pnpm test'], flows: { review: { schedule: '30 * * * *', concurrency: 5 } } },
        { schedule: '15 * * * *', flows: { review: { enabled: false } } },
      );

      expect(merged.schedule).toEqual({ local: Option.some('15 * * * *'), repo: Option.some('0 * * * *') });
      expect(flowSettings(merged, 'review')).toEqual(Option.some({ enabled: false, concurrency: 2 }));
      expect(merged.settings.localGate).toEqual(['pnpm test']);
      expect(merged.settings.humanOnly).toEqual(['a machine-wide limit']);
      expect(merged.settings.limits).toEqual(DEFAULT_LIMITS);
      expect(merged.settings.labels.eligible).toBe('auto:eligible');
    }),
  );

  effect(
    "the person's schedules beat the team's, a flow's own included",
    () => Effect.gen(function* () {
      const scheduled = defineFlow({ trigger: Effect.succeed([]), schedule: '45 * * * *', workflow: () => Effect.void });
      const unscheduled = defineFlow({ trigger: Effect.succeed([]), workflow: () => Effect.void });
      const team = { schedule: '0 * * * *', flows: { review: { schedule: '30 * * * *' } } };
      const scheduleOf = (local: typeof LocalConfigFile.Encoded, name: string, flow = unscheduled) => merge(team, local).pipe(Effect.map((merged) => scheduleFor(merged, name, flow, 0, 1)));

      expect(yield* scheduleOf({}, 'review')).toBe('30 * * * *');
      expect(yield* scheduleOf({}, 'implement', scheduled)).toBe('45 * * * *');
      expect(yield* scheduleOf({}, 'implement')).toBe('0 * * * *');
      expect(yield* scheduleOf({ schedule: '15 * * * *' }, 'review')).toBe('15 * * * *');
      expect(yield* scheduleOf({ schedule: '15 * * * *' }, 'implement', scheduled)).toBe('15 * * * *');
      expect(yield* scheduleOf({ schedule: '15 * * * *', flows: { review: { schedule: '5 * * * *' } } }, 'review')).toBe('5 * * * *');
      expect(yield* merge({}, {}).pipe(Effect.map((merged) => scheduleFor(merged, 'implement', unscheduled, 1, 3)))).toBe('20 * * * *');
    }),
  );

  effect(
    "a flow runs only on its runners' machines, unless the person turns it on",
    () => Effect.gen(function* () {
      const team = { runners: ['Alice'], flows: { review: { runners: ['alice', 'bob'] }, fix: { enabled: false } } };
      const offFor = (local: typeof LocalConfigFile.Encoded, flow: string, login: Option.Option<string>) => merge(team, local).pipe(Effect.map((merged) => flowOff(merged, flow, login)));

      expect(yield* offFor({}, 'implement', Option.some('alice'))).toEqual(Option.none());
      expect(yield* offFor({}, 'implement', Option.some('bob'))).toEqual(Option.some('not a runner (runners: Alice; this machine is bob)'));
      expect(yield* offFor({}, 'review', Option.some('bob'))).toEqual(Option.none());
      expect(yield* offFor({}, 'implement', Option.none())).toEqual(Option.some("not a runner (runners: Alice; this machine's GitHub login is unknown)"));
      expect(yield* offFor({ flows: { implement: { enabled: true } } }, 'implement', Option.some('bob'))).toEqual(Option.none());
      expect(yield* offFor({ flows: { review: { enabled: false } } }, 'review', Option.some('alice'))).toEqual(Option.some('flow turned off'));
      expect(yield* offFor({}, 'fix', Option.some('alice'))).toEqual(Option.some('flow turned off'));
      expect(yield* merge({}, {}).pipe(Effect.map((merged) => flowOff(merged, 'implement', Option.none())))).toEqual(Option.none());
      expect(flowSettings(yield* merge(team, {}), 'review')).toEqual(Option.some({}));
    }),
  );

  effect(
    'a flow filters work by assignee or requested reviewer only when the team or the person says so',
    () => Effect.gen(function* () {
      const team = { flows: { implement: { assignee: ['@me', 'none'] }, review: { reviewRequested: 'alice' } } };
      const merged = yield* merge(team, {});

      expect(routingOf(merged, 'implement')).toEqual({ assignee: Option.some(['@me', 'none']), reviewRequested: Option.none() });
      expect(routingOf(merged, 'review')).toEqual({ assignee: Option.none(), reviewRequested: Option.some(['alice']) });
      expect(routingOf(merged, 'fix')).toEqual({ assignee: Option.none(), reviewRequested: Option.none() });
      expect(needsLogin(merged)).toBe(true);
      expect(needsLogin(yield* merge({ flows: { review: { reviewRequested: 'alice' } } }, {}))).toBe(false);
      expect(needsLogin(yield* merge({}, {}))).toBe(false);
      expect(routingOf(yield* merge(team, yield* Schema.encodeEffect(LocalConfigFile)({ flows: { implement: { assignee: Option.none() } } })), 'implement').assignee).toEqual(Option.none());
      expect(routingOf(yield* merge({}, { flows: { review: { reviewRequested: '@me' } } }), 'review').reviewRequested).toEqual(Option.some(['@me']));
    }),
  );

  test('runners belong to the team, not to local.yaml', () => {
    const decoded = Schema.decodeUnknownResult(LocalConfigFile)({ flows: { review: { runners: ['me'] } } });
    expect(Option.map(Result.getFailure(decoded), (issue) => issue.message)).toEqual(Option.some(expect.stringContaining("runners is the team's choice")));
  });

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
    "records in local.yaml only the flow choices that differ from the team's",
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      const localPath = `${repo}/.chernabog/local.yaml`;
      const bob = Effect.succeedSome('bob');
      const localFlows = Effect.flatMap(fs.readFileString(localPath), (text) => Schema.decodeUnknownEffect(LocalConfigFile)(YAML.parse(text))).pipe(Effect.map((local) => local.flows));
      yield* scaffold(repo);
      yield* fs.remove(localPath);
      yield* fs.writeFileString(`${repo}/.chernabog/config.yaml`, 'runners: [alice]\nflows:\n  fix:\n    enabled: false\n  review:\n    runners: [alice, bob]\n');
      expect(yield* flowChoices(repo, bob)).toEqual([
        { name: 'fix', enabled: false, teamDefault: false, teamOff: Option.some('flow turned off') },
        { name: 'implement', enabled: false, teamDefault: false, teamOff: Option.some('not a runner (runners: alice; this machine is bob)') },
        { name: 'review', enabled: true, teamDefault: true, teamOff: Option.none() },
      ]);

      expect((yield* Effect.flip(chooseFlows(repo, ['implement', 'nope'], bob))).message).toContain('no flow named nope');
      expect(yield* fs.exists(localPath)).toBe(false);

      expect(yield* chooseFlows(repo, ['fix', 'implement', 'review'], bob)).toEqual([
        { name: 'fix', enabled: true },
        { name: 'implement', enabled: true },
        { name: 'review', enabled: true },
      ]);
      expect(yield* fs.readFileString(localPath)).toContain('# Your own settings for this repo');
      expect(yield* localFlows).toEqual({ fix: { enabled: true }, implement: { enabled: true } });
      expect((yield* flowChoices(repo, bob)).map((choice) => choice.enabled)).toEqual([true, true, true]);

      // Back to the team's choices: local.yaml keeps none of them.
      yield* chooseFlows(repo, ['review'], bob);
      expect(yield* localFlows).toBeUndefined();
      expect(yield* ensureLocalConfig(repo)).toBe(false);
    }),
  );

  effect(
    'asks GitHub who this machine is only when the team names runners',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      yield* scaffold(repo);
      const choices = yield* flowChoices(repo, Effect.die('looked up the login'));
      expect(choices.every((choice) => choice.enabled && choice.teamDefault)).toBe(true);
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
      expect(parseJson(yield* fs.readFileString(path))).toEqual(Option.some({ private: true, engines: { chernabog: `>=${VERSION}` }, devDependencies: BUNDLED_PACKAGES }));

      yield* fs.writeFileString(path, '{ "name": "flows", "dependencies": { "effect": "4.0.0", "zod": "^3" }, "devDependencies": { "@chernabog/sdk": "0.0.1", "typescript": "5" } }');
      expect(yield* scaffold(repo)).toEqual(['.chernabog/package.json (pins updated)']);
      expect(parseJson(yield* fs.readFileString(path))).toEqual(
        Option.some({ name: 'flows', dependencies: { zod: '^3' }, devDependencies: { typescript: '5', ...BUNDLED_PACKAGES }, engines: { chernabog: `>=${VERSION}` } }),
      );
      expect(yield* scaffold(repo)).toEqual([]);
    }),
  );

  effect(
    'raises the chernabog floor only when the repo picks up something of this binary',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      const path = `${repo}/.chernabog/package.json`;
      const floorOf = fs.readFileString(path).pipe(Effect.flatMap(decodeManifest), Effect.flatMap(requiredVersion));
      const withFloor = (floor: string) => `{ "engines": { "chernabog": "${floor}" }, "devDependencies": ${printJson(BUNDLED_PACKAGES)} }`;
      yield* scaffold(repo);

      yield* fs.writeFileString(path, withFloor('>=0.0.1'));
      expect(yield* scaffold(repo)).toEqual([]);
      expect(yield* floorOf).toEqual(Option.some('0.0.1'));

      yield* fs.writeFileString(`${repo}/.chernabog/config.schema.json`, '{}');
      expect(yield* scaffold(repo)).toEqual(['.chernabog/config.schema.json (updated)', '.chernabog/package.json (pins updated)']);
      expect(yield* floorOf).toEqual(Option.some(VERSION));
    }),
  );

  effect(
    'refuses a .chernabog/ that needs a newer chernabog, and writes nothing',
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-init-' });
      yield* fs.makeDirectory(`${repo}/.chernabog`);
      yield* fs.writeFileString(`${repo}/.chernabog/package.json`, '{ "engines": { "chernabog": ">=99.0.0" } }');
      const scaffolded = yield* Effect.result(scaffold(repo));
      expect(Result.isFailure(scaffolded) && scaffolded.failure.message).toContain('needs chernabog 99.0.0 or newer');
      expect(yield* fs.readDirectory(`${repo}/.chernabog`)).toEqual(['package.json']);
    }),
  );

  test('the repo slug comes from an https or ssh origin', () => {
    expect(slugFromRemote('git@github.com:dataquail/goodbones.git\n')).toEqual(Option.some('dataquail/goodbones'));
    expect(slugFromRemote('https://github.com/dataquail/goodbones')).toEqual(Option.some('dataquail/goodbones'));
    expect(slugFromRemote('/tmp/origin.git')).toEqual(Option.none());
  });
});

describe('loading a repo', () => {
  const configDirWith = (files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'chernabog-load-' });

      for (const [name, text] of Object.entries(files)) yield* fs.writeFileString(`${dir}/${name}`, text);

      return dir;
    });

  const load = (files: Readonly<Record<string, string>>) =>
    Effect.flatMap(configDirWith(files), (dir) => Effect.result(loadRepo(machine, { ...enrolled, path: dir }, dir)));

  effectAtHome('a .chernabog/ that needs a newer chernabog is refused, before its config is read', () =>
    Effect.gen(function* () {
      const loaded = yield* load({ 'package.json': '{ "engines": { "chernabog": ">=99.0.0" } }', 'config.yaml': 'notAKey: true\n' });
      expect(Result.isFailure(loaded) && loaded.failure.message).toBe(`.chernabog/ needs chernabog 99.0.0 or newer, and this is ${VERSION}; upgrade chernabog`);
    }),
  );

  effectAtHome('engines.chernabog must be a floor', () =>
    Effect.gen(function* () {
      const loaded = yield* load({ 'package.json': '{ "engines": { "chernabog": "garbage" } }' });
      expect(Result.isFailure(loaded) && loaded.failure.message).toContain('it must be a floor such as');
    }),
  );

  effectAtHome('a key this binary does not know fails the repo instead of being dropped', () =>
    Effect.gen(function* () {
      const loaded = yield* load({ 'package.json': `{ "engines": { "chernabog": ">=${VERSION}" } }`, 'config.yaml': 'limits:\n  ciRounds: 2\n  futureLimit: 1\n' });
      expect(Result.isFailure(loaded) && loaded.failure.message).toContain('["limits"]["futureLimit"]');
    }),
  );

  effectAtHome('a .chernabog/ without a floor loads on any binary', () =>
    Effect.gen(function* () {
      const loaded = yield* load({ 'config.yaml': 'baseBranch: develop\n' });
      expect(Result.isSuccess(loaded) && loaded.success.settings.baseBranch).toBe('develop');
    }),
  );
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
