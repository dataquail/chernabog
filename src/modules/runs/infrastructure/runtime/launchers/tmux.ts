// A detached tmux session per agent session, named after it.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Launcher, runTool, toolFailed } from "./launcher.ts";

const NAME = "tmux";

// tmux turns `.` and `:` in a session name into `_`; keep names as given.
export const tmuxSessionName = (title: string) => title.replace(/[^\w-]/g, "-");

// `=name` matches the session exactly, not by prefix.
const target = (handle: string) => `=${handle}`;

export const tmuxLauncher: Launcher = {
  name: NAME,
  start: (spec) =>
    Effect.gen(function* () {
      const handle = tmuxSessionName(spec.title);

      const result = yield* runTool(NAME, "tmux", [
        "new-session",
        "-d",
        "-s",
        handle,
        "-x",
        "200",
        "-y",
        "50",
        "-c",
        spec.cwd,
        ...spec.command,
      ]);

      if (result.exitCode !== 0) {
        return yield* toolFailed(NAME, "tmux new-session", result);
      }

      return handle;
    }),
  alive: (handle) =>
    Effect.map(
      runTool(NAME, "tmux", ["has-session", "-t", target(handle)]),
      (result) => result.exitCode === 0,
    ),
  // Already gone is closed.
  close: (handle) => Effect.asVoid(runTool(NAME, "tmux", ["kill-session", "-t", target(handle)])),
  attach: (handle) =>
    Option.some({ command: "tmux", args: ["attach-session", "-t", target(handle)] }),
  open: () => Option.none(),
  check: runTool(NAME, "tmux", ["-V"]).pipe(
    Effect.map((result) => {
      const ok = result.exitCode === 0;
      let label = "tmux: not found";

      if (ok) {
        label = `tmux: ${result.stdout.trim()}`;
      }

      return { ok, label, fix: "brew install tmux, or pick another launcher" };
    }),
    Effect.orElseSucceed(() => ({
      ok: false,
      label: "tmux: not found",
      fix: "brew install tmux, or pick another launcher",
    })),
  ),
};
