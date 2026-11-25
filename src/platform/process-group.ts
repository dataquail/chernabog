// A child process that leads a process group of its own (spawned detached,
// setsid): a signal to the group reaches it and everything it started, and a
// Ctrl-C in the terminal that started its parent doesn't. Its stdin is a pipe
// the parent holds open for the child's whole life, so the child can tell
// when its parent has gone, however it went. What a hub runs a spoke in
// (ADR 23, decision 1).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// How a process group's leader exited: its exit code, or the signal that
// ended it, or why it never started.
export type GroupExit = {
  readonly code: Option.Option<number>;
  readonly signal: Option.Option<string>;
  readonly failedToStart: Option.Option<string>;
};

// What its exit says, for a person: `exited 1`, `killed by SIGKILL`.
export const describeExit = (exit: GroupExit) =>
  Option.match(exit.failedToStart, {
    onSome: (why) => `could not start: ${why}`,
    onNone: () =>
      Option.match(exit.signal, {
        onSome: (signal) => `killed by ${signal}`,
        onNone: () => `exited ${Option.getOrElse(exit.code, () => 0)}`,
      }),
  });

// A line the leader wrote, on its stdout or its stderr.
export type GroupLine = { readonly stream: "stdout" | "stderr"; readonly text: string };

export type ProcessGroup = {
  // The leader's PID, which is also the group's id.
  readonly pid: number;
  // What the leader writes, a line at a time, until it closes its output.
  readonly lines: Stream.Stream<GroupLine>;
  // Waits for the leader to exit.
  readonly exited: Effect.Effect<GroupExit>;
  // Sends `signal` to every process in the group; nothing once it's gone.
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>;
  // Closes the leader's stdin, which it reads as its parent going.
  readonly closeStdin: Effect.Effect<void>;
};

export type SpawnGroupOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

// A signal that found no process in the group: it has gone.
const GoneError = Schema.Struct({ code: Schema.Literal("ESRCH") });
const isGone = Schema.is(GoneError);

export const spawnGroup = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnGroupOptions,
): Effect.Effect<ProcessGroup> =>
  Effect.sync(() => {
    const exit = Deferred.makeUnsafe<GroupExit>();

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.once("error", (error) => {
      Deferred.doneUnsafe(
        exit,
        Effect.succeed({
          code: Option.none(),
          signal: Option.none(),
          failedToStart: Option.some(error.message),
        }),
      );
    });
    child.once("exit", (code, signal) => {
      Deferred.doneUnsafe(
        exit,
        Effect.succeed({
          code: Option.fromNullishOr(code),
          signal: Option.fromNullishOr(signal),
          failedToStart: Option.none(),
        }),
      );
    });

    // A pipe the parent holds: writing to it after the child has gone is
    // nothing to fail on.
    child.stdin.on("error", () => {});

    // Read from the moment it spawns: an iterator made only once someone
    // reads would miss what the child wrote, and its end, meanwhile.
    const linesOf = (stream: GroupLine["stream"], from: NodeJS.ReadableStream) => {
      const lines = createInterface({ input: from, crlfDelay: Infinity })[Symbol.asyncIterator]();

      return Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => lines }, () => {}).pipe(
        Stream.map((text): GroupLine => ({ stream, text })),
        Stream.catchCause(() => Stream.empty),
      );
    };

    const stdout = linesOf("stdout", child.stdout);
    const stderr = linesOf("stderr", child.stderr);

    // No PID when the command couldn't start: there is no group to signal.
    const pid = Option.fromNullishOr(child.pid);

    return {
      pid: Option.getOrElse(pid, () => 0),
      lines: Stream.merge(stdout, stderr),
      exited: Deferred.await(exit),
      signal: (signal) =>
        Effect.forEach(Option.toArray(pid), (leader) =>
          Effect.try({
            try: () => process.kill(-leader, signal),
            catch: (error) => ({ gone: isGone(error), error }),
          }).pipe(
            Effect.catchIf(
              (failure) => failure.gone,
              () => Effect.void,
            ),
            Effect.orDie,
          ),
        ).pipe(Effect.asVoid),
      closeStdin: Effect.sync(() => {
        child.stdin.end();
      }),
    } satisfies ProcessGroup;
  });

// Stops a group: SIGTERM to every process in it, then, if its leader hasn't
// exited within `grace`, SIGKILL to the group. How its leader exited.
export const stopGroup = (group: ProcessGroup, grace: Duration.Duration) =>
  Effect.gen(function* () {
    yield* group.signal("SIGTERM");

    const exited = yield* group.exited.pipe(Effect.timeoutOption(grace));

    if (Option.isSome(exited)) {
      return exited.value;
    }

    yield* group.signal("SIGKILL");

    return yield* group.exited;
  });

// The grace a stop gives a spoke after SIGTERM, above its own 3-second
// shutdown deadline (withShutdownDeadline), before SIGKILL (ADR 23, decision 4).
export const STOP_GRACE = Duration.seconds(10);
