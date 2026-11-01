// The launchers an interactive agent session can run under. `headless` is the
// name for none: the agent runs as a child process, as `claude -p`.

import type { LauncherCommands, RepoSettings, ResolvedLauncher } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { customLauncher } from "./launchers/custom.ts";
import type { Launcher } from "./launchers/launcher.ts";
import { orcaLauncher } from "./launchers/orca.ts";
import { tmuxLauncher } from "./launchers/tmux.ts";

export type LaunchersConfig = Readonly<Record<string, LauncherCommands>>;

export const BUILT_IN_LAUNCHERS: ReadonlyArray<string> = ["headless", "orca", "tmux"];

const BUILT_IN = [orcaLauncher, tmuxLauncher];

// The launcher to start sessions with; none for headless.
export const launcherFor = (resolved: ResolvedLauncher): Option.Option<Launcher> =>
  Option.match(resolved.custom, {
    onNone: () => Arr.findFirst(BUILT_IN, (launcher) => launcher.name === resolved.name),
    onSome: (commands) => Option.some(customLauncher(resolved.name, commands)),
  });

export const isInteractive = (resolved: ResolvedLauncher) => Option.isSome(launcherFor(resolved));

// Whether a repo's sessions run under a launcher that can bring one up itself
// (Orca, tmux), for the dashboard's "Open in launcher". Only Claude runs
// interactively; another agent runs headless whatever the launcher.
export const opensSessions = (settings: RepoSettings) =>
  settings.agent === "claude" &&
  Option.exists(launcherFor(settings.launcher), (launcher) => Option.isSome(launcher.open));

// "orca (machine config)", and a note when the repo's agent has no interactive mode to use it.
export const describeLauncher = (settings: RepoSettings) => {
  const chosen = `${settings.launcher.name} (${settings.launcher.from})`;

  if (isInteractive(settings.launcher) && settings.agent !== "claude") {
    return `${chosen}; ${settings.agent} runs headless regardless`;
  }

  return chosen;
};

export type { Handle, Launcher, LaunchSpec } from "./launchers/launcher.ts";
