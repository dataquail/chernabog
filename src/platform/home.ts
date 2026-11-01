// Where chernabog keeps its files on this machine, and the person's home.

import { homedir } from "node:os";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Where Chernabog keeps machine config and state (CHERNABOG_HOME moves it, for
// tests and trials), and the person's own home directory.
export class Home extends Context.Service<Home, { readonly root: string; readonly user: string }>()(
  "chernabog/Home",
) {
  public static readonly layer = Layer.effect(
    Home,
    Effect.gen(function* () {
      const user = homedir();

      const root = yield* Config.String("CHERNABOG_HOME").pipe(
        Config.withDefault(`${user}/.config/chernabog`),
      );

      return Home.of({ root, user });
    }).pipe(Effect.orDie),
  );

  public static readonly at = (root: string, user: string) =>
    Layer.succeed(Home, Home.of({ root, user }));
}

export const expandHome = (path: string, home: string) => {
  if (path === "~" || path.startsWith("~/")) {
    return `${home}${path.slice(1)}`;
  }

  return path;
};

// Machine config, state, logs and telemetry, under the Chernabog home.
export const homePaths = (root: string) => ({
  machineConfig: `${root}/config.yaml`,
  state: `${root}/state.db`,
  engineLock: `${root}/state.db.lock`,
  socket: `${root}/daemon.sock`,
  // The daemon's own log, which it turns over each UTC day (daily-log.ts).
  daemonLog: `${root}/daemon.log`,
  // What the service manager catches of the daemon's stdout and stderr:
  // crashes, and anything said before its own log starts.
  daemonOutLog: `${root}/daemon.out.log`,
  paused: `${root}/paused.json`,
  reloaded: `${root}/reloaded.json`,
  trust: `${root}/trust.json`,
  // Whether the dashboard's 127.0.0.1 listener is to run, and its port.
  dashboard: `${root}/dashboard.json`,
  // The token a browser opens the dashboard with, only the person may read.
  dashboardToken: `${root}/dashboard.token`,
  runs: `${root}/runs`,
  runLog: (runId: string) => `${root}/runs/${runId}.log`,
  sessions: `${root}/sessions`,
  snapshots: `${root}/snapshots`,
  rehearsals: `${root}/rehearsals`,
  // Each process's spans and logs, a folder a day (FileTelemetry).
  telemetry: `${root}/telemetry`,
  // Copies of machine config and state.db from before a newer chernabog migrated them.
  backups: `${root}/backups`,
  worktrees: (repo: string) => `${root}/worktrees/${repo}`,
  usageLog: (account: string) => `${root}/usage-${account}.jsonl`,
});
