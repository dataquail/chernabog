// A launcher from machine config: command templates with {command} (the whole
// command, quoted for a shell), {cwd}, {title} and {handle}. `start` prints the
// handle, or nothing to make {title} the handle. Without `alive`, a session
// counts as running until the agent is done.

import type { LauncherCommands } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { fillCommand } from "../agents/custom.ts";
import { type Launcher, runTool, shellCommand, toolFailed } from "./launcher.ts";

const run = (
  name: string,
  template: ReadonlyArray<string>,
  values: Readonly<Record<string, string>>,
) => {
  const [command = "sh", ...args] = fillCommand(template, values);

  return runTool(name, command, args);
};

export const customLauncher = (name: string, commands: LauncherCommands): Launcher => ({
  name,
  start: (spec) =>
    Effect.gen(function* () {
      const result = yield* run(name, commands.start, {
        command: shellCommand(spec.command),
        cwd: spec.cwd,
        title: spec.title,
      });

      if (result.exitCode !== 0) {
        return yield* toolFailed(name, `${name} start`, result);
      }

      const printed = result.stdout.trim();

      if (printed.length > 0) {
        return printed;
      }

      return spec.title;
    }),
  alive: (handle) =>
    Option.match(commands.alive, {
      onNone: () => Effect.succeed(true),
      onSome: (template) =>
        Effect.map(run(name, template, { handle }), (result) => result.exitCode === 0),
    }),
  close: (handle) => Effect.asVoid(run(name, commands.close, { handle })),
  attach: (handle) =>
    Option.flatMap(commands.attach, (template) => {
      const [command, ...args] = fillCommand(template, { handle });

      return Option.map(Option.fromUndefinedOr(command), (found) => ({ command: found, args }));
    }),
  check: Effect.gen(function* () {
    const command = Option.getOrElse(Arr.head(commands.start), () => "");

    const found = yield* runTool(name, "sh", ["-c", 'command -v "$1"', "sh", command]).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

    return {
      ok: found,
      label: `${name}: ${command} is on the PATH`,
      fix: `install ${command}, or fix launchers.${name}.start in machine config`,
    };
  }),
});
