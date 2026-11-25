// The rogue-run rehearsal (ADR 23, decision 4, #666), through the real CLI
// and daemon against the fake GitHub, the fake tmux and the fake claude. One
// hub runs stand-in runs that go wrong in each way #611 and its cousins can,
// beside ordinary runs that do their work: one replays a step in a hot loop,
// flooding its telemetry; one floods its run log; one hangs on an agent that
// never answers; one grows its memory; and one spins without yielding, with
// a child that ignores SIGTERM, so it hears no SIGTERM either. Each rogue
// opened an agent session first. Each is ended within its bound, its run
// failed naming the bound, its process group gone (by SIGKILL after the
// grace, for the one deaf to SIGTERM), its journal deleted and its agent
// session closed; meanwhile the hub stays up, the ordinary runs finish, and
// the hub takes new work once the rogues are gone.

import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Says on the issue which process it runs in and takes the issue's label
// off, so no later tick starts it again. An "ordinary ..." issue then takes
// its claim, works for 20 seconds, a line a second, and records its phase.
// Any other is a rogue: it claims the issue, opens an agent session in a
// worktree (held at its prompt, so it never answers), waits until the
// session's launch is recorded, and then goes wrong as its title says.
const ROGUE = `import { activity, Agent, Claims, defineFlow, GitHub, Implement, Issue, Phases, reportAs, RunLog } from "@chernabog/sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Logs a line a second, so it is never idle, for \`seconds\` (forever, unset),
// holding \`held\` while it does.
const working = (seconds: number, held?: unknown) =>
  Effect.gen(function* () {
    const log = yield* RunLog;

    for (let tick = 0; tick < seconds; tick++) {
      yield* log.log(\`working \${tick} \${typeof held}\`);
      yield* Effect.sleep("1 second");
    }
  });

// An agent session that never answers, on a fiber of its own, once its
// launch is recorded, which is where the hub finds its handle to close it.
const openSession = (issue: number, cwd: string) =>
  Effect.gen(function* () {
    const agent = yield* Agent;
    const sessionId = \`\${issue}-rogue-session\`;

    const session = yield* Effect.forkChild(
      agent.run({
        cwd,
        prompt: "Hold on.",
        sessionId,
        resumePrompt: Option.none(),
        outputSchema: Option.none(),
        adapter: Option.none(),
      }),
    );

    const launch = join(process.env.CHERNABOG_HOME ?? "", "sessions", "interactive", sessionId, "launch.json");

    while (!existsSync(launch)) {
      yield* Effect.sleep("200 millis");
    }

    return session;
  });

export default defineFlow({
  concurrency: 8,
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("rogue");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const title = item.title ?? "";
      const pid = yield* activity("pid", Effect.sync(() => String(process.pid)), Schema.String);
      yield* Issue.comment(issue, \`pid \${pid}\`);
      yield* activity("unlabel", Effect.flatMap(GitHub, (github) => github.removeLabel(issue, "rogue")));

      if (title.startsWith("ordinary")) {
        yield* activity("claim", Claims.acquire(item.key).pipe(Effect.asVoid));
        yield* activity("work", working(20));
        yield* activity("record-phase", Phases.record(item.key, "worked"));

        return "worked beside the rogues";
      }

      const { base, branch } = yield* Implement.claim(issue);
      const worktree = yield* Implement.prepareWorktree(branch, { base });
      const session = yield* openSession(issue, worktree);

      // #611's shape: a step replayed as fast as it can go, a span each
      // pass, and now and then a line to say so.
      if (title.startsWith("hot loop")) {
        yield* activity(
          "replay",
          Effect.gen(function* () {
            const log = yield* RunLog;

            for (let pass = 0; ; pass++) {
              yield* Effect.void.pipe(Effect.withSpan(\`replay-\${pass}\`));

              if (pass % 1000 === 0) {
                yield* log.log(\`replayed \${pass} times\`);
              }
            }
          }),
        );
      }

      if (title.startsWith("flood")) {
        yield* activity(
          "flood",
          Effect.gen(function* () {
            const log = yield* RunLog;

            for (let line = 0; ; line++) {
              yield* log.log(\`flood \${line} \${"x".repeat(1000)}\`);
              yield* Effect.sleep("10 millis");
            }
          }),
        );
      }

      // No step progress: it waits on the agent, which never answers.
      if (title.startsWith("hang")) {
        yield* activity("await-agent", Fiber.join(session).pipe(Effect.ignore));
      }

      if (title.startsWith("memory")) {
        yield* activity(
          "allocate",
          Effect.suspend(() => working(Number.POSITIVE_INFINITY, Buffer.alloc(1_200_000_000, 1))),
        );
      }

      // Deaf to SIGTERM: a child that traps it, and a spin that never yields,
      // so the spoke's own handler never runs.
      if (title.startsWith("deaf")) {
        const child = yield* activity(
          "child",
          Effect.sync(() =>
            String(spawn("sh", ["-c", "trap '' TERM; sleep 600"], { stdio: "ignore" }).pid),
          ),
          Schema.String,
        );

        yield* Issue.comment(issue, \`child \${child}\`);
        yield* activity(
          "spin",
          Effect.sync(() => {
            for (;;) {
              Date.now();
            }
          }),
        );
      }

      return "never gets here";
    }),
});
`;

// Tight enough for each rogue to break its bound in seconds, and loose enough
// that the ordinary runs, and each rogue, break no other.
const BOUNDS = {
  telemetry: "2 MB",
  runLog: "20 kB",
  phaseTime: "2 minutes",
  idle: "15 seconds",
  memory: "800 MB",
};

// The hub's grace between SIGTERM and SIGKILL (STOP_GRACE), and its sample's
// interval (SAMPLE_EVERY), in millis.
const GRACE = 10_000;
const SAMPLE = 5_000;

// What may come on top of them: the last fold, the run's ending and closing
// its session, on a machine as loaded as these rogues make it.
const SLACK = 10_000;

// Whether a process is alive, by its PID: `kill -0` reaches it.
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

// Each rogue, and the bound it breaks.
const ROGUES = [
  { title: "hot loop replaying a step", bound: "telemetry" },
  { title: "flood the run log", bound: "run log" },
  { title: "hang on an agent", bound: "idle" },
  { title: "memory hog", bound: "memory" },
  { title: "deaf to SIGTERM", bound: "idle" },
] as const;

type Rogue = (typeof ROGUES)[number] & { readonly issue: number };

describe("the rogue-run rehearsal", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;
  let daemonExit: Promise<number> = Promise.resolve(0);
  let hold = "";
  const socket = () => join(sandbox.home, "daemon.sock");

  const commentsOn = (issue: number) =>
    sandbox.github.commentsOn(issue).map((comment) => comment.body);

  // What the issue's run said on it: the PID it ran in, the child it started.
  const said = (issue: number, what: "pid" | "child") =>
    Arr.findFirst(commentsOn(issue), (body) =>
      Option.map(Option.fromNullishOr(new RegExp(`^${what} (\\d+)$`).exec(body)), (found) =>
        Number(found[1]),
      ),
    );

  // A line of the daemon's log, and when it was written, in millis.
  const logged = (pattern: RegExp) =>
    Arr.findFirst(sandbox.daemonLog().split("\n"), (line) =>
      Option.map(Option.fromNullishOr(pattern.exec(line)), (found) => ({
        at: Date.parse(line.slice(0, line.indexOf(" "))),
        found,
      })),
    );

  // The issue's run the daemon logged finishing: its id, how and why, and when.
  const finished = (issue: number) =>
    Option.map(
      logged(
        new RegExp(`finished ([\\da-f-]{36}) \\(demo/rogue issue-${issue}\\): ([a-z-]+): (.*)$`),
      ),
      ({ at, found }) => ({
        runId: String(found[1]),
        status: String(found[2]),
        summary: String(found[3]),
        at,
      }),
    );

  // When the hub found the run past a bound and began to end its spoke.
  const endingBegan = (runId: string) =>
    Option.map(
      logged(new RegExp(`spoke for ${runId.slice(0, 8)} ended past its .*; ending it$`)),
      ({ at }) => at,
    );

  const sessionHandle = (issue: number) => `chernabog-${`${issue}-rogue-session`.slice(0, 8)}`;

  const spokeRecords = () => {
    const db = new Database(join(sandbox.home, "state.db"), { readonly: true });
    const rows = db.query("SELECT run_id FROM om_spokes").all();
    db.close();

    return rows;
  };

  const telemetryBytesOf = (runId: string) => {
    const telemetry = join(sandbox.home, "telemetry");

    return readdirSync(telemetry)
      .flatMap((day) =>
        readdirSync(join(telemetry, day))
          .filter((name) => name.startsWith(`spoke-${runId}-`))
          .map((name) => join(telemetry, day, name)),
      )
      .reduce((total, file) => total + statSync(file).size, 0);
  };

  const status = async () =>
    Schema.decodeUnknownSync(Schema.Struct({ active: Schema.Array(Schema.Unknown) }))(
      await (await fetch("http://daemon/status", { unix: socket() })).json(),
    );

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      {
        launcher: "tmux",
        flows: { rogue: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/rogue.ts": ROGUE },
        concurrency: 8,
        spokes: BOUNDS,
      },
    );
    await sandbox.runCli(["trust", "demo"]);

    // Every agent session waits at its prompt while this file exists.
    hold = join(sandbox.root, "hold-agents");
    writeFileSync(hold, "");

    const started = sandbox.cli(["daemon"], { FAKE_CLAUDE_HOLD: hold });
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

    // A failed test can leave a held session; end each one's group. The `--`
    // keeps procps' kill from reading `-9 -<pid>` as every process.
    const tmux = join(sandbox.root, "tmux");

    const pidFiles = Option.match(Option.liftPredicate(tmux, existsSync), {
      onNone: () => [],
      onSome: (dir) => [...new Bun.Glob("*.pid").scanSync(dir)],
    });

    for (const pidFile of pidFiles) {
      Bun.spawnSync(["kill", "-9", "--", `-${readFileSync(join(tmux, pidFile), "utf8")}`]);
    }

    rmSync(hold, { force: true });
    await sandbox.github.stop();
  });

  test("each rogue spoke is ended within its bound, while the hub and the ordinary runs carry on", async () => {
    const ordinary = [
      sandbox.github.addIssue("ordinary work, first", ["rogue"]),
      sandbox.github.addIssue("ordinary work, second", ["rogue"]),
    ];

    const rogues: ReadonlyArray<Rogue> = ROGUES.map((rogue) => ({
      ...rogue,
      issue: sandbox.github.addIssue(rogue.title, ["rogue"]),
    }));

    // The hub answers all the while.
    let answered = 0;

    await waitFor(
      () => {
        void status().then(() => {
          answered += 1;
        });

        return [...ordinary, ...rogues.map((rogue) => rogue.issue)].every((issue) =>
          Option.isSome(finished(issue)),
        );
      },
      "every run to end",
      240_000,
    );

    expect(Option.fromNullishOr(daemon.exitCode)).toEqual(Option.none());
    expect(answered).toBeGreaterThan(0);
    expect((await status()).active).toEqual([]);

    // The ordinary runs did their work, untouched by any bound.
    for (const issue of ordinary) {
      const run = Option.getOrThrow(finished(issue));
      expect([run.status, run.summary]).toEqual(["done", "worked beside the rogues"]);
      expect(endingBegan(run.runId)).toEqual(Option.none());
    }

    for (const rogue of rogues) {
      const run = Option.getOrThrow(finished(rogue.issue));
      const pid = Option.getOrThrow(said(rogue.issue, "pid"));
      const began = Option.getOrThrow(endingBegan(run.runId));
      const handle = sessionHandle(rogue.issue);

      // Failed, naming the bound it broke.
      expect([rogue.title, run.status]).toEqual([rogue.title, "failed"]);
      expect(run.summary).toContain(`ended past its ${rogue.bound} bound`);

      // Ended within the grace, and some slack, of the hub's finding it past
      // its bound; its process gone, and its journal.
      expect(run.at - began).toBeLessThan(GRACE + SLACK);
      expect(alive(pid)).toBe(false);
      expect(existsSync(join(sandbox.home, "journals", `${run.runId}.db`))).toBe(false);

      // Its agent session closed, by its handle.
      expect(sandbox.daemonLog()).toContain(`closed its tmux session ${handle}`);
      expect(sandbox.tmuxCalls()).toContain(`kill-session -t =${handle}`);
      expect(existsSync(join(sandbox.root, "tmux", `${handle}.pid`))).toBe(false);
    }

    const byTitle = (prefix: string) =>
      Option.getOrThrow(Arr.findFirst(rogues, (rogue) => rogue.title.startsWith(prefix)));

    const runOf = (prefix: string) => Option.getOrThrow(finished(byTitle(prefix).issue));

    // The hot loop's telemetry, and the flood's run log, stopped at their
    // bounds, each with one line saying so.
    const hot = runOf("hot loop");
    expect(telemetryBytesOf(hot.runId)).toBeLessThan(2_000_000 + 1_000);

    const flood = runOf("flood");
    const floodLog = join(sandbox.home, "runs", `${flood.runId}.log`);
    expect(
      readFileSync(floodLog, "utf8").match(/this run's log stopped at its bound of 20 kB/g),
    ).toHaveLength(1);
    expect(statSync(floodLog).size).toBeLessThan(20_000 + 2_000);

    // The idle ones were found within a sample of their bound.
    for (const prefix of ["hang", "deaf"]) {
      const idle = Number(/: (\d+)s over 15s/.exec(runOf(prefix).summary)?.[1]);
      expect([prefix, idle <= (15_000 + SAMPLE + 3_000) / 1000]).toEqual([prefix, true]);
    }

    // The one deaf to SIGTERM outlived it, and went with its child by SIGKILL
    // once the grace was up.
    const deaf = runOf("deaf");
    expect(deaf.at - Option.getOrThrow(endingBegan(deaf.runId))).toBeGreaterThanOrEqual(
      GRACE - 1_000,
    );
    expect(alive(Option.getOrThrow(said(byTitle("deaf").issue, "child")))).toBe(false);

    // The hub let go of every spoke.
    await waitFor(() => spokeRecords().length === 0, "every spoke record to be forgotten");
  }, 300_000);

  test("the hub takes new work once the rogues are gone", async () => {
    const issue = sandbox.github.addIssue("ordinary work, after", ["rogue"]);

    await waitFor(() => Option.isSome(finished(issue)), "the new run to end", 90_000);

    expect(Option.map(finished(issue), (run) => run.status)).toEqual(Option.some("done"));
    expect(Option.fromNullishOr(daemon.exitCode)).toEqual(Option.none());
  }, 120_000);
});
