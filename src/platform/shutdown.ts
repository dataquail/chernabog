// How long a stop may take. On SIGINT or SIGTERM, runMain interrupts the
// program and waits for its finalizers, however long they take, and ignores
// a second signal. A person who pressed Ctrl-C won't wait long, and launchd
// and systemd follow SIGTERM with SIGKILL anyway. Correctness doesn't depend on
// a clean stop: a run's workflow is journaled and an interrupted start is
// recovered at the next startup (RecoverRunsCommand). So a stop gets a
// deadline, after which the process exits, and a second Ctrl-C exits at once.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

type Signal = "SIGINT" | "SIGTERM";

// The parts of the process a stop's deadline uses, so a test can stand in.
export type ShutdownHost = {
  readonly on: (signal: Signal, listener: () => void) => void;
  readonly off: (signal: Signal, listener: () => void) => void;
  readonly exit: (code: number) => void;
  // Calls `fire` after `millis`, without keeping the process alive for it.
  readonly after: (millis: number, fire: () => void) => void;
  readonly warn: (line: string) => void;
};

// The exit code a shell gives a process a signal ended: 128 plus its number.
const exitCodes: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143 };

const processHost: ShutdownHost = {
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  off: (signal, listener) => {
    process.off(signal, listener);
  },
  exit: (code) => process.exit(code),
  after: (millis, fire) => {
    setTimeout(fire, millis).unref();
  },
  warn: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

// Arms the deadline on `host`; the function that disarms it.
export const armShutdownDeadline = (host: ShutdownHost, deadline: Duration.Duration) => {
  let stopping = false;

  const listeners = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const listener = () => {
      if (stopping) {
        host.exit(exitCodes[signal]);

        return;
      }

      stopping = true;
      host.after(Duration.toMillis(deadline), () => {
        host.warn(
          `chernabog: still stopping after ${Duration.format(deadline)}; exiting (anything unfinished resumes at the next start)`,
        );
        host.exit(exitCodes[signal]);
      });
    };

    host.on(signal, listener);

    return { signal, listener };
  });

  return () => {
    for (const { listener, signal } of listeners) {
      host.off(signal, listener);
    }
  };
};

// The program, stopping within `deadline` of a SIGINT or SIGTERM.
export const withShutdownDeadline =
  (deadline: Duration.Input, host: ShutdownHost = processHost) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => armShutdownDeadline(host, Duration.fromInputUnsafe(deadline))),
      () => self,
      (disarm) => Effect.sync(disarm),
    );

// The parts of the process stopping when stdin closes uses, so a test can
// stand in: watching stdin for its end (the function that stops watching),
// and stopping as on SIGTERM.
export type StdinHost = {
  readonly watch: (closed: () => void) => () => void;
  readonly stop: () => void;
};

const processStdin: StdinHost = {
  watch: (closed) => {
    process.stdin.once("end", closed);
    process.stdin.once("close", closed);
    process.stdin.resume();

    return () => {
      process.stdin.off("end", closed);
      process.stdin.off("close", closed);
      // Destroyed only once nothing listens, so it says nothing more, and a
      // spoke that ended on its own doesn't wait on its stdin to exit.
      process.stdin.destroy();
    };
  },
  stop: () => {
    process.kill(process.pid, "SIGTERM");
  },
};

// Stops the process as on SIGTERM, deadline and all, once its stdin closes,
// for as long as the scope lasts. A spoke's stdin is a pipe its hub holds
// open, so a spoke dies with its hub, however the hub exits (ADR 23,
// decision 7).
export const stopWhenStdinCloses = (host: StdinHost = processStdin) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let stopped = false;

      return host.watch(() => {
        if (!stopped) {
          stopped = true;
          host.stop();
        }
      });
    }),
    (unwatch) => Effect.sync(unwatch),
  );
