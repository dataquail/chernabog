// How an interactive agent session is hosted: an Orca terminal, a tmux
// session, or a command of your own. A launcher starts one command in a
// directory, then says whether it still runs, closes it, and tells a person how
// to look at it. When the agent is done is not its business: a Stop hook
// decides that the same way under every launcher.

import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Exec, type ExecResult } from "../../../../../platform/exec.ts";

export class LaunchError extends Schema.TaggedError<
  LaunchError,
  { readonly brand: "LaunchError" }
>()("LaunchError", {
  launcher: Schema.String,
  message: Schema.String,
}) {}

export type LaunchSpec = {
  readonly title: string;
  readonly cwd: string;
  readonly command: ReadonlyArray<string>;
};

// Opaque and launcher-specific; recorded so a restarted daemon finds the session again.
export type Handle = string;

export type LauncherAttach = { readonly command: string; readonly args: ReadonlyArray<string> };

export type ToolCheck = { readonly ok: boolean; readonly label: string; readonly fix: string };

export type Launcher = {
  readonly name: string;
  readonly start: (spec: LaunchSpec) => Effect.Effect<Handle, LaunchError, Exec>;
  readonly alive: (handle: Handle) => Effect.Effect<boolean, LaunchError, Exec>;
  readonly close: (handle: Handle) => Effect.Effect<void, LaunchError, Exec>;
  // What `chernabog attach` runs; none falls back to the agent's own resume.
  readonly attach: (handle: Handle) => Option.Option<LauncherAttach>;
  // Whether the tool it drives is installed and working, for doctor.
  readonly check: Effect.Effect<ToolCheck, never, Exec>;
};

const SAFE = /^[\w@%+=:,./-]+$/;

export const shellQuote = (part: string) => {
  if (SAFE.test(part)) {
    return part;
  }

  return `'${part.replaceAll("'", `'\\''`)}'`;
};

export const shellCommand = (command: ReadonlyArray<string>) => command.map(shellQuote).join(" ");

// Runs one of the launcher's tool commands; a non-zero exit is the caller's to read.
export const runTool = (launcher: string, command: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(Exec, (exec) => exec.run(command, args, { timeout: "30 seconds" })).pipe(
    Effect.mapError((error) => new LaunchError({ launcher, message: error.message })),
  );

export const saidBy = (result: ExecResult) => {
  const said = result.stderr.trim();

  if (said.length > 0) {
    return said;
  }

  return result.stdout.trim();
};

export const toolFailed = (launcher: string, what: string, result: ExecResult) =>
  new LaunchError({ launcher, message: `${what} exited ${result.exitCode}: ${saidBy(result)}` });
