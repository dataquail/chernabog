// Where a repo's agent sessions run (ADR 24): on the host, or in a Docker or
// Podman container. A sandbox that can't start refuses the session, saying
// why, and nothing ever falls back to running it on the host (decision 2).

import type { ResolvedSandbox } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Exec } from "../../../../platform/exec.ts";

// What a session would run as, for whether its sandbox can hold it.
export type SandboxedSession = {
  readonly adapter: string;
  // Under a launcher, through `chernabog __launch`, which runs the container.
  readonly interactive: boolean;
  readonly platform: string;
};

const named = (sandbox: ResolvedSandbox) => `sandbox ${sandbox.name} (from ${sandbox.from})`;

// The agents whose sessions run in a container.
const CONTAINED: ReadonlyArray<string> = ["claude", "codex"];

const NEVER_ON_HOST = "and never runs a sandboxed repo's session on the host instead";

// Why a session in this sandbox can't start, from what is known without
// asking the runtime; none when it may.
export const sandboxRefusal = (
  sandbox: ResolvedSandbox,
  session: SandboxedSession,
): Option.Option<string> => {
  if (sandbox.name === "none") {
    return Option.none();
  }

  // Decision 1: a Windows path is no path in a Linux container.
  if (session.platform === "win32") {
    return Option.some(
      `${named(sandbox)} isn't supported on Windows, where a worktree can't be mounted at its own path; set sandbox: none, where the repo's allowedSandboxes allows it`,
    );
  }

  // Decision 4: Claude and Codex; opencode and custom adapters refuse.
  if (!CONTAINED.includes(session.adapter)) {
    return Option.some(
      `${named(sandbox)}: this chernabog can't run a ${session.adapter} session in a container yet, ${NEVER_ON_HOST}; only ${CONTAINED.join(" and ")} run sandboxed so far`,
    );
  }

  // Codex runs headless under any launcher, its adapter running the
  // container; Claude's interactive session is __launch's to run in one.
  if (session.adapter === "claude" && !session.interactive) {
    return Option.some(
      `${named(sandbox)}: this chernabog runs a sandboxed claude session only under a launcher (orca, tmux or your own), not headless, ${NEVER_ON_HOST}`,
    );
  }

  return Option.none();
};

// Whether the sandbox's runtime answers: installed, and its daemon or
// machine running. None when it does, or for none.
export const sandboxUnavailable = (sandbox: ResolvedSandbox) =>
  Effect.gen(function* () {
    if (sandbox.name === "none") {
      return Option.none<string>();
    }

    const exec = yield* Exec;
    const runtime = sandbox.name;

    const said = yield* exec.run(runtime, ["info"], { timeout: "30 seconds" }).pipe(
      Effect.map((result) =>
        Option.some(result).pipe(
          Option.filter(({ exitCode }) => exitCode !== 0),
          Option.map(({ exitCode, stderr, stdout }) =>
            Option.getOrElse(
              Arr.findFirst([stderr.trim(), stdout.trim()], (text) => text.length > 0),
              () => `exited ${exitCode}`,
            ).slice(0, 400),
          ),
        ),
      ),
      Effect.catch((error) => Effect.succeedSome(error.message)),
    );

    const start = Option.match(
      Option.liftPredicate(runtime, (name) => name === "podman"),
      {
        onNone: () => "",
        onSome: () => " (`podman machine start` on macOS)",
      },
    );

    return Option.map(
      said,
      (reason) =>
        `${named(sandbox)} can't start: \`${runtime} info\` failed (${reason}); install ${runtime} and start it${start}, ${NEVER_ON_HOST}`,
    );
  });
