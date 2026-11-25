// The hub bounds each spoke (ADR 23, decision 4, #663), through the real CLI
// and daemon against the fake GitHub: a spoke that floods its run log or its
// telemetry, runs past its phase time, goes idle, or grows past its memory
// is ended, SIGTERM to its group and SIGKILL after the grace, and its run
// fails naming the bound it broke. Its journal is gone, and the files it
// flooded stopped at their bounds, with a line saying so.

import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Says on the issue which process it runs in, takes the issue's label off so
// no later tick starts it again, then does what the issue's title says:
// floods its run log ("run log"), floods its telemetry ("telemetry"), sleeps
// writing nothing ("idle"), works on, logging every second, for longer than
// its phase may last ("phase time"), or holds a gigabyte while it works on
// ("memory").
const BOUNDED = `import { activity, defineFlow, GitHub, Implement, Issue, RunLog } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const workingOn = (held: unknown) =>
  Effect.gen(function* () {
    const log = yield* RunLog;

    for (let tick = 0; ; tick++) {
      yield* log.log(\`still working \${tick} \${typeof held}\`);
      yield* Effect.sleep("1 second");
    }
  });

export default defineFlow({
  concurrency: 5,
  trigger: Effect.flatMap(GitHub, (github) => github.queuedIssuesLabelled("bounded")).pipe(
    Effect.map((issues) => issues.map((issue) => Implement.issueItem(issue))),
    Effect.orDie,
  ),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const title = item.title ?? "";
      const pid = yield* activity("pid", Effect.sync(() => String(process.pid)), Schema.String);
      yield* Issue.comment(issue, \`pid \${pid}\`);
      yield* activity("unlabel", Effect.flatMap(GitHub, (github) => github.removeLabel(issue, "bounded")));

      if (title.startsWith("run log")) {
        yield* activity(
          "flood-log",
          Effect.gen(function* () {
            const log = yield* RunLog;

            for (let line = 0; line < 2000; line++) {
              yield* log.log(\`flood \${line} \${"x".repeat(100)}\`);
            }

            yield* workingOn(undefined);
          }),
        );
      }

      if (title.startsWith("telemetry")) {
        yield* activity(
          "flood-telemetry",
          Effect.gen(function* () {
            for (let round = 0; ; round++) {
              yield* Effect.forEach(
                Array.from({ length: 2000 }, (_, at) => at),
                (at) => Effect.void.pipe(Effect.withSpan(\`flood-\${round}-\${at}\`)),
                { discard: true },
              );
              yield* Effect.sleep("100 millis");
            }
          }),
        );
      }

      if (title.startsWith("idle")) {
        yield* activity("idle", Effect.sleep("10 minutes"));
      }

      if (title.startsWith("phase time")) {
        yield* activity("busy", workingOn(undefined));
      }

      if (title.startsWith("memory")) {
        yield* activity(
          "allocate",
          Effect.suspend(() => workingOn(Buffer.alloc(1_200_000_000, 1))),
        );
      }

      return "never gets here";
    }),
});
`;

// The bounds, tight enough for a test to break each in seconds, and loose
// enough that a spoke breaks only the one its issue asks for.
const BOUNDS = {
  telemetry: "2 MB",
  runLog: "20 kB",
  phaseTime: "30 seconds",
  idle: "15 seconds",
  memory: "800 MB",
};

// Whether a process is alive, by its PID: `kill -0` reaches it.
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

describe("the hub's bounds on its spokes", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;
  let daemonExit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox.home, "daemon.sock");

  // The PID the issue's run said it ran in.
  const ranIn = (issue: number) =>
    Arr.findFirst(sandbox.github.commentsOn(issue), (comment) =>
      Option.map(Option.fromNullishOr(/^pid (\d+)$/.exec(comment.body)), (said) => Number(said[1])),
    );

  // The issue's run the daemon logged finishing: its id, how and why.
  const finished = (issue: number) =>
    Arr.head(
      [
        ...sandbox
          .daemonLog()
          .matchAll(
            new RegExp(
              `finished ([\\da-f-]{36}) \\(demo/bounded issue-${issue}\\): ([a-z-]+): (.*)`,
              "g",
            ),
          ),
      ].map((found) => ({
        runId: String(found[1]),
        status: String(found[2]),
        summary: String(found[3]),
      })),
    );

  // Opens an issue that breaks a bound, and waits for its run to end.
  const breaking = async (title: string) => {
    const issue = sandbox.github.addIssue(title, ["bounded"]);

    await waitFor(() => Option.isSome(finished(issue)), `the "${title}" run to end`, 120_000);

    const run = Option.getOrThrow(finished(issue));
    const pid = Option.getOrThrow(ranIn(issue));

    // Its spoke was ended and its journal deleted, and its run failed.
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(sandbox.home, "journals", `${run.runId}.db`))).toBe(false);
    expect(run.status).toBe("failed");

    return run;
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      {
        flows: { bounded: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/bounded.ts": BOUNDED },
        concurrency: 5,
        spokes: BOUNDS,
      },
    );
    await sandbox.runCli(["trust", "demo"]);

    const started = sandbox.cli(["daemon"]);
    daemon = started;
    let output = "";

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };

    started.stdout.on("data", collect);
    started.stderr.on("data", collect);

    daemonExit = new Promise((resolve) => {
      started.on("close", (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), `the daemon's socket (${output})`);
  }, 60_000);

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    if (Option.isNone(Option.fromNullishOr(daemon.exitCode))) {
      daemon.kill("SIGTERM");
    }

    await daemonExit;
    await sandbox.github.stop();
  });

  test("a spoke that floods its run log is ended past its run-log bound, and its log stopped there", async () => {
    const run = await breaking("run log flood");

    expect(run.summary).toContain("ended past its run log bound");
    expect(run.summary).toContain("over 20 kB");

    // The spoke's writer stopped at the bound, with one line saying so; the
    // hub's own notes of the ending come after it.
    const log = readFileSync(join(sandbox.home, "runs", `${run.runId}.log`), "utf8");
    expect(log.match(/this run's log stopped at its bound of 20 kB/g)).toHaveLength(1);
    expect(log).not.toContain("flood 1999");
    expect(statSync(join(sandbox.home, "runs", `${run.runId}.log`)).size).toBeLessThan(
      20_000 + 2_000,
    );
  }, 150_000);

  test("a spoke that floods its telemetry is ended past its telemetry bound, its files stopped there", async () => {
    const run = await breaking("telemetry flood");

    expect(run.summary).toContain("ended past its telemetry bound");
    expect(run.summary).toContain("over 2 MB");

    // Its files, over every day folder, stopped at the bound, the last line
    // saying so.
    const telemetry = join(sandbox.home, "telemetry");

    const files = readdirSync(telemetry).flatMap((day) =>
      readdirSync(join(telemetry, day))
        .filter((name) => name.startsWith(`spoke-${run.runId}-`))
        .map((name) => join(telemetry, day, name)),
    );

    const bytes = files.reduce((total, file) => total + statSync(file).size, 0);
    const text = files.map((file) => readFileSync(file, "utf8")).join("");

    expect(bytes).toBeLessThan(2_000_000 + 1_000);
    expect(text).toContain("telemetry stopped at its bound of 2 MB");
  }, 150_000);

  test("a spoke that writes nothing for longer than its idle bound is ended past it", async () => {
    const run = await breaking("idle sleeper");

    expect(run.summary).toContain("ended past its idle bound");
    expect(run.summary).toContain("over 15s");
    expect(run.summary).toContain("interrupted in idle");
  }, 150_000);

  test("a spoke that works on past its phase time is ended past it, though never idle", async () => {
    const run = await breaking("phase time overrun");

    expect(run.summary).toContain("ended past its phase time bound");
    expect(run.summary).toContain("over 30s");
    expect(run.summary).toContain("interrupted in busy");
  }, 150_000);

  test("a spoke whose memory grows past its bound is ended past it", async () => {
    const run = await breaking("memory hog");

    expect(run.summary).toContain("ended past its memory bound");
    expect(run.summary).toContain("over 800 MB");
  }, 150_000);
});
