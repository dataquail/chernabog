import { homedir } from 'node:os';

import type { Account } from '@chernabog/sdk';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

export class ConfigError extends Schema.TaggedError<ConfigError, { readonly brand: 'ConfigError' }>()('ConfigError', {
  message: Schema.String,
}) {}

// Where Chernabog keeps machine config and state (CHERNABOG_HOME moves it, for
// tests and trials), and the person's own home directory.
export class Home extends Context.Service<Home, { readonly root: string; readonly user: string }>()('chernabog/Home') {
  public static readonly layer = Layer.effect(
    Home,
    Effect.gen(function* () {
      const user = homedir();
      const root = yield* Config.String('CHERNABOG_HOME').pipe(Config.withDefault(`${user}/.config/chernabog`));

      return Home.of({ root, user });
    }).pipe(Effect.orDie),
  );

  public static readonly at = (root: string, user: string) => Layer.succeed(Home, Home.of({ root, user }));
}

export const expandHome = (path: string, home: string) => {
  if (path === '~' || path.startsWith('~/')) return `${home}${path.slice(1)}`;

  return path;
};

// Where an account keeps its settings, skills and session transcripts.
export const claudeHomeOf = (account: Account, home: string) => Option.getOrElse(account.configDir, () => `${home}/.claude`);

// Machine config, state and logs, under the Chernabog home.
export const homePaths = (root: string) => ({
  machineConfig: `${root}/config.yaml`,
  state: `${root}/state.db`,
  engineLock: `${root}/state.db.lock`,
  socket: `${root}/daemon.sock`,
  daemonLog: `${root}/daemon.log`,
  paused: `${root}/paused.json`,
  trust: `${root}/trust.json`,
  runs: `${root}/runs`,
  runLog: (runId: string) => `${root}/runs/${runId}.log`,
  sessions: `${root}/sessions`,
  snapshots: `${root}/snapshots`,
  worktrees: (repo: string) => `${root}/worktrees/${repo}`,
  usageLog: (account: string) => `${root}/usage-${account}.jsonl`,
});

// Where a Codex account keeps its login and session logs.
export const codexHomeOf = (account: Account, home: string) => Option.getOrElse(account.configDir, () => `${home}/.codex`);
