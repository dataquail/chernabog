// Runs an agent CLI headless: the prompt on stdin, each line of its output
// handed to `onLine` as it arrives, so the run log shows the agent at work.

import { AgentError } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import type { Environment } from "../platform/environment.ts";

export type AgentProcess = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  // The whole environment the agent runs with.
  readonly env: Environment;
  readonly stdin: string;
};

export type Finished = { readonly exitCode: number; readonly stderr: string };

const STDERR_KEPT = 8000;

export const runAgentProcess = <R>(
  spec: AgentProcess,
  onLine: (line: string) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        extendEnv: false,
        stdin: { stream: Stream.make(new TextEncoder().encode(spec.stdin)) },
        forceKillAfter: "10 seconds",
      }),
    );

    const lines = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach(onLine),
    );

    const [, stderr, exitCode] = yield* Effect.all(
      [lines, Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
      { concurrency: "unbounded" },
    );

    return { exitCode: Number(exitCode), stderr: stderr.slice(-STDERR_KEPT) } satisfies Finished;
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new AgentError({ message: `${spec.command}: ${error.message}` })),
  );

export const clip = (text: string, length = 240) => {
  if (text.length > length) {
    return `${text.slice(0, length)}…`;
  }

  return text;
};
