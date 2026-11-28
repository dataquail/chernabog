// `chernabog __launch <spec.json>`: the one short command a launcher runs. It
// starts the agent in the foreground on the terminal, with exactly the
// environment in the spec and the prompt read from a file, so a long prompt
// never passes through a shell or tmux's quoting, and every launcher gives the
// agent the same environment. With a sandbox, what it starts is the agent in
// a Docker or Podman container (container.ts), still in the foreground.

import { SandboxName } from "@chernabog/core";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import { HostEnvironment } from "../../../../../platform/environment.ts";
import {
  type ContainerCommand,
  containerRunArgs,
  ContainerSpec,
  removeSessionContainers,
  SESSION_LABEL,
} from "./container.ts";

export const LaunchSpecFile = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  // Read and passed as the last argument.
  promptFile: Schema.optionalKey(Schema.String),
  // Holds this process's pid while the agent runs, so a session can be told
  // apart from a launcher that only says it ended.
  pidFile: Schema.optionalKey(Schema.String),
  // Where the agent runs (ADR 24): none, docker or podman. Absent, from a
  // spec written before it, is none.
  sandbox: Schema.optionalKey(SandboxName),
  // For docker or podman: the image, mounts and labels of its container.
  container: Schema.optionalKey(ContainerSpec),
});

export type LaunchSpecFile = typeof LaunchSpecFile.Type;

export const LaunchSpecJson = Schema.fromJsonString(LaunchSpecFile);

// A hangup on the terminal (its tab or pane closed), or a stop.
const ENDING_SIGNALS = ["SIGHUP", "SIGTERM"] as const;

const SIGNAL_EXIT: Readonly<Record<(typeof ENDING_SIGNALS)[number], number>> = {
  SIGHUP: 129,
  SIGTERM: 143,
};

type EndingSignal = (typeof ENDING_SIGNALS)[number];

// Listens for ENDING_SIGNALS from now until the scope closes, completing
// the Deferred it gives with the first. Listening starts before the agent does, so a hangup
// that comes as soon as it is up is never missed.
const listenForEndingSignal = Effect.gen(function* () {
  const signalled = yield* Deferred.make<EndingSignal>();

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      ENDING_SIGNALS.map((signal) => {
        const handler = () => {
          Deferred.doneUnsafe(signalled, Effect.succeed(signal));
        };

        process.once(signal, handler);

        return [signal, handler] as const;
      }),
    ),
    (handlers) =>
      Effect.sync(() => {
        for (const [signal, handler] of handlers) {
          process.off(signal, handler);
        }
      }),
  );

  return signalled;
});

type Runtime = "docker" | "podman";

// What runs on the terminal: the agent itself, or the runtime's CLI running
// it in the session's container, with the session's label to remove it by.
const launchedFor = (
  spec: LaunchSpecFile,
  agent: ContainerCommand,
  host: { readonly variables: Readonly<Record<string, string>>; readonly platform: string },
) =>
  Option.match(
    Option.all({
      runtime: Option.filter(
        Option.fromUndefinedOr(spec.sandbox),
        (name): name is Runtime => name !== "none",
      ),
      container: Option.fromUndefinedOr(spec.container),
    }),
    {
      onNone: () => ({
        command: agent.command,
        args: agent.args,
        env: agent.env,
        container: Option.none<{ runtime: Runtime; session: Option.Option<string> }>(),
      }),
      onSome: ({ container, runtime }) => ({
        command: runtime,
        args: containerRunArgs(runtime, agent, container, {
          platform: host.platform,
          uid: Option.fromUndefinedOr(process.getuid?.()),
          gid: Option.fromUndefinedOr(process.getgid?.()),
          tty: process.stdin.isTTY,
        }),
        // The runtime's CLI runs with this process's environment, for its own
        // socket and config, and the spec's, which it hands the container by name.
        env: { ...host.variables, ...spec.env },
        container: Option.some({
          runtime,
          session: Option.fromUndefinedOr(container.labels[SESSION_LABEL]),
        }),
      }),
    },
  );

export const runLaunch = (specFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const host = yield* HostEnvironment;
    const spec = yield* Schema.decodeEffect(LaunchSpecJson)(yield* fs.readFileString(specFile));
    const sandbox = spec.sandbox ?? "none";

    // A sandbox it can't start refuses the session rather than running the agent on the host.
    if (sandbox !== "none" && Option.isNone(Option.fromUndefinedOr(spec.container))) {
      yield* Console.error(
        `chernabog: sandbox ${sandbox} (from the launch spec) names no container to run the agent in, and a sandboxed session never runs on the host`,
      );

      return 1;
    }

    const prompt = yield* Effect.forEach(
      Option.toArray(Option.fromUndefinedOr(spec.promptFile)),
      (file) => fs.readFileString(file),
    );

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pidFile = Option.fromUndefinedOr(spec.pidFile);

    yield* Effect.forEach(Option.toArray(pidFile), (file) =>
      fs.writeFileString(file, String(process.pid)),
    );

    const launched = launchedFor(
      spec,
      { command: spec.command, args: [...spec.args, ...prompt], cwd: spec.cwd, env: spec.env },
      host,
    );

    // Not detached: the agent keeps this terminal as its controlling one, so it
    // gets resizes, and closing the terminal hangs it up.
    const child = ChildProcess.make(launched.command, [...launched.args], {
      cwd: spec.cwd,
      env: launched.env,
      extendEnv: false,
      detached: false,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      forceKillAfter: "5 seconds",
    });

    const exited = spawner.spawn(child).pipe(
      Effect.flatMap((handle) => handle.exitCode),
      Effect.map(Number),
    );

    // A container outlives its runtime's CLI, so a hangup, or a stop, removes
    // it before this process ends; on the host the agent ends with the terminal.
    const ran = Option.match(
      Option.flatMap(launched.container, ({ runtime, session }) =>
        Option.map(session, (id) => removeSessionContainers(runtime, id, launched.env)),
      ),
      {
        onNone: () => exited,
        // The runtime's CLI gets the hangup too, and may be seen to exit, or
        // fail as killed, before the signal is: however the wait ends, the
        // session's containers are removed (none are left after a clean
        // exit, with --rm), and a signal that came by then is what it exits with.
        onSome: (removed) =>
          Effect.flatMap(listenForEndingSignal, (signalled) =>
            Effect.raceFirst(
              exited,
              Effect.map(Deferred.await(signalled), (signal) => SIGNAL_EXIT[signal]),
            ).pipe(
              Effect.ensuring(removed),
              Effect.exit,
              Effect.flatMap((ended) =>
                Effect.gen(function* () {
                  if (yield* Deferred.isDone(signalled)) {
                    return SIGNAL_EXIT[yield* Deferred.await(signalled)];
                  }

                  return yield* ended;
                }),
              ),
            ),
          ),
      },
    );

    return yield* ran.pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.forEach(Option.toArray(pidFile), (file) =>
          fs.remove(file, { force: true }).pipe(Effect.ignore),
        ),
      ),
    );
  });
