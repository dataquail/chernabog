// A child process that leads a process group of its own (spawned detached,
// setsid): a signal to the group reaches it and everything it started, and a
// Ctrl-C in the terminal that started its parent doesn't. Its stdin is a pipe
// the parent holds open for the child's whole life, so the child can tell
// when its parent has gone, however it went. What a hub runs a spoke in
// (ADR 23, decision 1).

import { execFile, execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
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

// The resident memory of each process group, in bytes, by its id, from `ps`'s
// lines of a group id and a resident size in kilobytes, as both macOS and
// Linux print them: what a hub measures a spoke's memory by, its whole group
// summed (ADR 23, decision 4). A line that doesn't read is left out.
export const parseGroupMemory = (text: string): ReadonlyMap<number, number> => {
  const byGroup = new Map<number, number>();

  for (const line of text.split("\n")) {
    const [group, kilobytes] = line.trim().split(/\s+/).map(Number);

    if (Number.isInteger(group) && Number.isFinite(kilobytes)) {
      byGroup.set(group, (byGroup.get(group) ?? 0) + kilobytes * 1024);
    }
  }

  return byGroup;
};

// Every process group's resident memory, as `ps` says now; empty when it
// can't say, which measures nothing past a bound.
export const groupsMemory: Effect.Effect<ReadonlyMap<number, number>> = Effect.callback<
  ReadonlyMap<number, number>
>((resume) => {
  execFile("ps", ["-A", "-o", "pgid=,rss="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    resume(
      Effect.succeed(
        Option.match(Option.fromNullishOr(error), {
          onNone: () => parseGroupMemory(stdout),
          onSome: () => new Map<number, number>(),
        }),
      ),
    );
  });
});

// A process as the OS describes it: when it started, to the second, as `ps`
// prints it (`Wed Nov 25 10:00:00 2026`), and its command line. Its start
// time tells it from a later process the OS gave the same PID.
export type ProcessIdentity = { readonly startedAt: string; readonly command: string };

// `ps -o lstart=,command=`'s line: a start time of five fixed fields, then the
// command line. None for a line that doesn't read.
export const parseIdentity = (line: string): Option.Option<ProcessIdentity> =>
  Option.map(
    Option.fromNullishOr(
      /^\s*(\w{3} +\w{3} +\d{1,2} +\d{2}:\d{2}:\d{2} +\d{4})\s+(.*\S)\s*$/s.exec(line),
    ),
    (found) => ({
      startedAt: String(found[1]).replace(/ +/g, " "),
      command: String(found[2]),
    }),
  );

// The process with that PID, as `ps` says now; none when there is none, or
// `ps` can't say. In the C locale, so the start time reads the same whichever
// process asks.
export const processIdentity = (pid: number): Effect.Effect<Option.Option<ProcessIdentity>> =>
  Effect.callback<Option.Option<ProcessIdentity>>((resume) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resume(Effect.succeedNone);

      return;
    }

    execFile(
      "ps",
      ["-o", "lstart=", "-o", "command=", "-p", String(pid)],
      { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resume(
          Effect.succeed(
            Option.flatMap(
              Option.liftPredicate(stdout, () => Option.isNone(Option.fromNullishOr(error))),
              parseIdentity,
            ),
          ),
        );
      },
    );
  });

// Whether a number can name a group another process leads: 0 and 1 name
// the caller's own group and init's, which nothing here may signal.
const isOthersGroup = (group: number) => Number.isInteger(group) && group > 1;

// Whether any process of the group is alive: signal 0 to the group reaches
// one. A group whose processes this one may not signal is alive too.
export const groupAlive = (group: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => process.kill(-group, 0),
    catch: (error) => isGone(error),
  }).pipe(
    Effect.as(true),
    Effect.catch((gone) => Effect.succeed(!gone)),
    Effect.when(Effect.succeed(isOthersGroup(group))),
    Effect.map(Option.getOrElse(() => false)),
  );

// How a group another process started ended once signalled: gone after
// SIGTERM, gone after SIGKILL, or still there after both.
export type GroupEnd = "terminated" | "killed" | "survived";

// Waits up to `within` for the group to be gone, looking every `every`.
const goneWithin = (group: number, within: Duration.Duration, every: Duration.Duration) =>
  groupAlive(group).pipe(
    Effect.repeat({
      while: (alive) => alive,
      schedule: Schedule.spaced(every),
      times: Math.max(1, Math.ceil(Duration.toMillis(within) / Duration.toMillis(every))),
    }),
    Effect.map((alive) => !alive),
  );

// Ends a process group this process didn't spawn, and so can't wait on the
// exit of: SIGTERM to the group, then SIGKILL once `grace` has passed with
// any of it alive, and waits up to `grace` again for it to be gone. What a
// hub that starts does to a spoke of the hub before it (ADR 23, decision 7),
// once it has checked the group's leader is that spoke.
export const endForeignGroup = (
  group: number,
  grace: Duration.Duration,
  every: Duration.Duration = Duration.millis(100),
): Effect.Effect<GroupEnd> =>
  Effect.gen(function* () {
    const signal = (name: NodeJS.Signals) =>
      Effect.when(
        Effect.try(() => process.kill(-group, name)).pipe(Effect.ignore),
        Effect.succeed(isOthersGroup(group)),
      );

    yield* signal("SIGTERM");

    if (yield* goneWithin(group, grace, every)) {
      return "terminated" as const;
    }

    yield* signal("SIGKILL");

    if (yield* goneWithin(group, grace, every)) {
      return "killed" as const;
    }

    return "survived" as const;
  });

// SIGKILLs every other process in the group `leader` leads, as `ps` lists
// them, leaving the leader to exit as it was going to. Synchronous, for an
// exit handler; what has gone already, or what `ps` can't list, is let be.
export const killGroupBut = (leader: number): void => {
  Effect.runSync(
    Effect.try(() => execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })).pipe(
      Effect.map((listed) =>
        listed
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number))
          .filter(([pid, group]) => group === leader && pid !== leader)
          .map(([pid]) => Number(pid)),
      ),
      Effect.flatMap((others) =>
        Effect.forEach(others, (pid) =>
          Effect.ignore(Effect.try(() => process.kill(pid, "SIGKILL"))),
        ),
      ),
      Effect.ignore,
    ),
  );
};
