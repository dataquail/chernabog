// A throwaway repo with the scaffolded .chernabog/ on its base branch, a fake
// GitHub for it (refs in a local bare repo), a fake `claude` on PATH, and the
// CLI pointed at all of it.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Json } from '@chernabog/sdk';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';

import { scaffoldFiles } from '../../src/init.ts';
import { startFakeGitHub } from './fake-github.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SLUG = 'dataquail/demo';

// `install: null`, as config.yaml says there is no install step.
const NO_INSTALL = Schema.encodeSync(Schema.OptionFromNullOr(Schema.String))(Option.none());

export type MachineOptions = {
  readonly accounts?: Readonly<Record<string, Json>>;
  readonly account?: string;
  readonly agents?: Readonly<Record<string, Json>>;
  readonly launcher?: string;
  readonly launchers?: Readonly<Record<string, Json>>;
};

export type CliResult = { readonly code: number; readonly output: string };

const repoConfigText = (template: string, repoConfig: Readonly<Record<string, Json>>) => {
  const document = YAML.parseDocument(template);
  document.set('install', NO_INSTALL);
  document.set('localGate', ['test -n "$(ls change-*.txt)"']);

  for (const [key, value] of Object.entries(repoConfig)) document.set(key, value);

  return document.toString();
};

const machineConfigText = (root: string, checkout: string, machine: MachineOptions) => {
  const document = new YAML.Document({
    accounts: { work: { configDir: join(root, 'claude'), expectedEmail: 'dev@example.com' }, codex: { agent: 'codex', configDir: join(root, 'codex') }, ...machine.accounts },
    repos: [{ path: checkout, repo: SLUG, name: 'demo', account: machine.account ?? 'work', baseBranch: 'main' }],
  });

  for (const key of ['agents', 'launcher', 'launchers'] as const) {
    const value = Option.fromUndefinedOr(machine[key]);

    if (Option.isSome(value)) document.set(key, value.value);
  }

  return document.toString();
};

const callsIn = (file: string) => {
  if (!existsSync(file)) return [];

  return readFileSync(file, 'utf8').trim().split('\n');
};

// CHERNABOG_BIN tests a compiled binary instead of the source.
const chernabogCommand = () =>
  Option.match(Option.fromUndefinedOr(process.env.CHERNABOG_BIN), {
    onNone: () => [process.execPath, join(ROOT, 'src/main.ts')],
    onSome: (bin) => [bin],
  });

export const openSandbox = (repoConfig: Readonly<Record<string, Json>> = {}, machine: MachineOptions = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'chernabog-e2e-'));
  const bare = join(root, 'origin.git');
  const checkout = join(root, 'demo');
  const home = join(root, 'home');
  const git = (cwd: string, ...args: Array<string>) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, checkout]);
  const files = scaffoldFiles();

  for (const [relative, content] of Object.entries({ ...files, 'config.yaml': repoConfigText(files['config.yaml'], repoConfig) })) {
    const path = join(checkout, '.chernabog', relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  writeFileSync(join(checkout, 'README.md'), '# demo\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'chore: set up chernabog');
  git(checkout, 'push', '-q', 'origin', 'main');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), machineConfigText(root, checkout, machine));
  const github = startFakeGitHub({ slug: SLUG, bare });
  const claudeLog = join(root, 'claude.log');

  const env = {
    ...process.env,
    CHERNABOG_HOME: home,
    CHERNABOG_GITHUB_API: github.url,
    GH_TOKEN: 'test-token',
    PATH: `${join(ROOT, 'test/fakebin')}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_CODEX_LOG: join(root, 'codex.log'),
    FAKE_OPENCODE_LOG: join(root, 'opencode.log'),
    FAKE_TMUX_STATE: join(root, 'tmux'),
    FAKE_TMUX_LOG: join(root, 'tmux.log'),
    FAKE_ORCA_STATE: join(root, 'orca'),
    FAKE_ORCA_LOG: join(root, 'orca.log'),
    CHERNABOG_USAGE_URL: `${github.url}/api/oauth/usage`,
  };

  const [program = 'chernabog', ...programArgs] = chernabogCommand();

  const cli = (args: ReadonlyArray<string>, extraEnv: Readonly<Record<string, string>> = {}) =>
    spawn(program, [...programArgs, ...args], { env: { ...env, ...extraEnv }, cwd: checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const runCli = (args: ReadonlyArray<string>, extraEnv: Readonly<Record<string, string>> = {}) =>
    new Promise<CliResult>((resolve) => {
      const child = cli(args, extraEnv);
      let output = '';

      const collect = (chunk: Buffer) => {
        output += chunk.toString();
      };

      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      // Killed by a signal, a child has no exit code.
      child.on('close', (code) => {
        resolve({ code: code ?? -1, output });
      });
    });

  // Agent starts and resumes; the Stop hook's runs are in hookCalls.
  const claudeCalls = () => callsIn(claudeLog).filter((line) => !line.startsWith('stop-hook '));
  const hookCalls = () => callsIn(claudeLog).filter((line) => line.startsWith('stop-hook '));
  const tmuxCalls = () => callsIn(join(root, 'tmux.log'));
  const orcaCalls = () => callsIn(join(root, 'orca.log'));
  const codexCalls = () => callsIn(join(root, 'codex.log'));
  const opencodeCalls = () => callsIn(join(root, 'opencode.log'));
  const daemonLog = () => callsIn(join(home, 'daemon.log')).join('\n');

  return { root, bare, checkout, home, github, cli, runCli, claudeCalls, hookCalls, tmuxCalls, orcaCalls, codexCalls, opencodeCalls, daemonLog, git, env };
};

export type Sandbox = ReturnType<typeof openSandbox>;

export const waitFor = async (check: () => boolean, what: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);

    await Bun.sleep(100);
  }
};

// Resolves when a spawned child exits.
export const closed = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    child.on('close', () => {
      resolve();
    });
  });
