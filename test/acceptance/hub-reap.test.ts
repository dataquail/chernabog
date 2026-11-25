// A hub that dies with SIGKILL while its spokes run (ADR 23, decision 7,
// #664), through the real CLI and daemon against the fake GitHub. A spoke
// whose hub has gone stops, and takes what it started with it; one too busy
// to notice is reaped by the next hub, which checks its PID is still that
// spoke's first. Every run the dead hub left ends as interrupted, its journal
// gone, and its phase is taken up again by a new run from what the ledger
// recorded. A run the dead hub was cancelling ends cancelled, as it meant,
// and nothing takes it up again.

import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Takes the issue's claim, says on the issue which process it runs in and
// which phase the ledger had for the item, then records its phase. On its
// first phase only, an issue titled "orphan ..." starts a child that ignores
// SIGTERM, says its PID, and holds the run in a long step; one titled
// "spin ..." spins in a step without ever yielding, so its spoke can't hear
// its stdin close or run a signal handler. The flow takes its label off once
// done, so its trigger offers each issue until a run gets that far.
const REAP = `import { activity, Claims, defineFlow, GitHub, Implement, Issue, Phases, reportAs } from "@chernabog/sdk";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export default defineFlow({
  concurrency: 2,
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("reap");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const title = item.title ?? "";
      yield* activity("claim", Claims.acquire(item.key).pipe(Effect.asVoid));

      const pid = yield* activity("pid", Effect.sync(() => String(process.pid)), Schema.String);

      const before = yield* activity(
        "phase-before",
        Phases.current(item.key).pipe(
          Effect.map(Option.match({ onNone: () => "none", onSome: (found) => found.phase })),
        ),
        Schema.String,
      );

      yield* Issue.comment(issue, \`pid \${pid} from \${before}\`);
      yield* activity("record-phase", Phases.record(item.key, "working"));

      if (before === "none" && title.startsWith("orphan")) {
        const child = yield* activity(
          "child",
          Effect.sync(() =>
            String(spawn("sh", ["-c", "trap '' TERM; sleep 600"], { stdio: "ignore" }).pid),
          ),
          Schema.String,
        );

        yield* Issue.comment(issue, \`child \${child}\`);
        yield* activity("hold", Effect.sleep("10 minutes"));
      }

      if (before === "none" && title.startsWith("spin")) {
        yield* activity(
          "spin",
          Effect.sync(() => {
            for (;;) {
              Date.now();
            }
          }),
        );
      }

      yield* activity("unlabel", Effect.flatMap(GitHub, (github) => github.removeLabel(issue, "reap")));

      return \`worked in \${pid}\`;
    }),
});
`;

// Whether a process is alive, by its PID: `kill -0` reaches it.
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

describe("a hub killed while its spokes run", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;
  let daemonExit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox.home, "daemon.sock");

  const startDaemon = async () => {
    // A hub killed outright leaves its socket behind.
    rmSync(socket(), { force: true });
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
  };

  const killDaemon = async () => {
    daemon.kill("SIGKILL");
    await daemonExit;
  };

  const stopDaemon = async () => {
    if (Option.isNone(Option.fromNullishOr(daemon.exitCode))) {
      daemon.kill("SIGTERM");
    }

    await daemonExit;
  };

  const commentsOn = (issue: number) =>
    sandbox.github.commentsOn(issue).map((comment) => comment.body);

  // The PIDs the issue's runs said they ran in, and the phase each found.
  const ranIn = (issue: number) =>
    commentsOn(issue).flatMap((body) =>
      Option.toArray(
        Option.map(Option.fromNullishOr(/^pid (\d+) from (\S+)$/.exec(body)), (said) => ({
          pid: Number(said[1]),
          before: String(said[2]),
        })),
      ),
    );

  // The child an orphan's run started, as it said.
  const childOf = (issue: number) =>
    Option.getOrThrow(
      Arr.findFirst(commentsOn(issue), (body) =>
        Option.map(Option.fromNullishOr(/^child (\d+)$/.exec(body)), (said) => Number(said[1])),
      ),
    );

  // The runs of an issue the daemon logged finishing, and how.
  const finished = (issue: number) =>
    [
      ...sandbox
        .daemonLog()
        .matchAll(
          new RegExp(`finished ([\\da-f-]{36}) \\(demo/reap issue-${issue}\\): ([a-z-]+)`, "g"),
        ),
    ].map((found) => ({ runId: String(found[1]), status: String(found[2]) }));

  // The id of the issue's run in flight, once the hub's status shows it in `step`.
  const inStep = async (issue: number, step: string) => {
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      const found = Arr.findFirst(
        DaemonStatus.pipe(Schema.decodeUnknownSync)(
          await (await fetch("http://daemon/status", { unix: socket() })).json(),
        ).active,
        (run) => run.itemKey === `issue-${issue}` && Option.contains(run.currentStep, step),
      );

      if (Option.isSome(found)) {
        return found.value.id;
      }

      await Bun.sleep(250);
    }

    throw new Error(`timed out waiting for the run for #${issue} to be in ${step}`);
  };

  // What state.db's om_spokes holds: each recorded spoke's run and the
  // ending meant for it.
  const spokeRecords = () => {
    const db = new Database(join(sandbox.home, "state.db"), { readonly: true });
    const rows = db.query("SELECT run_id, ending FROM om_spokes").all();
    db.close();

    return Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({ run_id: Schema.String, ending: Schema.OptionFromNullOr(Schema.String) }),
      ),
    )(rows);
  };

  const journalOf = (runId: string) => join(sandbox.home, "journals", `${runId}.db`);

  // Takes the issue's label off, so its trigger offers it to no new run.
  const unlabel = (issue: number) => {
    const { labels } = sandbox.github.issue(issue);
    labels.splice(labels.indexOf("reap"), 1);
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      {
        flows: { reap: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/reap.ts": REAP },
        concurrency: 2,
      },
    );
    await sandbox.runCli(["trust", "demo"]);
    await startDaemon();
  }, 60_000);

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    await stopDaemon();
    await sandbox.github.stop();
  });

  test("leaves no spoke, child or journal behind, and each run's phase is taken up again", async () => {
    const orphan = sandbox.github.addIssue("orphan a child", ["reap"]);
    const spin = sandbox.github.addIssue("spin forever", ["reap"]);

    const orphanRun = await inStep(orphan, "hold");
    const spinRun = await inStep(spin, "spin");

    const orphanSpoke = Option.getOrThrow(Arr.head(ranIn(orphan))).pid;
    const spinSpoke = Option.getOrThrow(Arr.head(ranIn(spin))).pid;
    const child = childOf(orphan);

    expect([alive(orphanSpoke), alive(spinSpoke), alive(child)]).toEqual([true, true, true]);
    expect(
      spokeRecords()
        .map((record) => record.run_id)
        .toSorted(),
    ).toEqual([orphanRun, spinRun].toSorted());

    await killDaemon();

    // The spoke that hears its stdin close stops, and takes its child, which
    // ignores SIGTERM, with it. The spinning one can't hear it.
    await waitFor(
      () => !alive(orphanSpoke) && !alive(child),
      "the orphan's spoke and child to end",
      30_000,
    );
    expect(alive(spinSpoke)).toBe(true);

    await startDaemon();

    // The next hub reaps the spinning spoke (SIGKILL, after SIGTERM's grace),
    // ends both runs as interrupted, and new runs take both items up from
    // the phase their records hold.
    await waitFor(
      () =>
        finished(orphan).some((run) => run.status === "done") &&
        finished(spin).some((run) => run.status === "done"),
      "new runs to finish both items",
      120_000,
    );

    expect(finished(orphan).map((run) => run.status)).toEqual(["interrupted", "done"]);
    expect(finished(spin).map((run) => run.status)).toEqual(["interrupted", "done"]);
    expect([Arr.head(finished(orphan)), Arr.head(finished(spin))]).toEqual([
      Option.some({ runId: orphanRun, status: "interrupted" }),
      Option.some({ runId: spinRun, status: "interrupted" }),
    ]);
    expect(ranIn(orphan).map((ran) => ran.before)).toEqual(["none", "working"]);
    expect(ranIn(spin).map((ran) => ran.before)).toEqual(["none", "working"]);

    // No process, journal, hand-over or record is left of the dead hub's spokes.
    expect([alive(orphanSpoke), alive(spinSpoke), alive(child)]).toEqual([false, false, false]);
    expect([existsSync(journalOf(orphanRun)), existsSync(journalOf(spinRun))]).toEqual([
      false,
      false,
    ]);
    expect(
      readdirSync(join(sandbox.home, "spokes")).filter(
        (name) => name.startsWith(orphanRun) || name.startsWith(spinRun),
      ),
    ).toEqual([]);
    expect(sandbox.daemonLog()).toContain(
      `the spoke ${spinSpoke} of ${spinRun.slice(0, 8)} from the hub before was still running, and was killed by SIGKILL`,
    );
    await waitFor(() => spokeRecords().length === 0, "every spoke record to be forgotten", 30_000);
  }, 240_000);

  test("a run the dead hub was cancelling ends cancelled, and nothing takes it up again", async () => {
    const issue = sandbox.github.addIssue("spin until cancelled", ["reap"]);
    const runId = await inStep(issue, "spin");
    const spoke = Option.getOrThrow(Arr.head(ranIn(issue))).pid;
    unlabel(issue);

    // The cancel waits out the spinning spoke's grace; the hub records the
    // ending it means before it signals the spoke, and dies meanwhile.
    const cancel = sandbox.cli(["cancel", runId.slice(0, 8)]);

    await waitFor(
      () =>
        spokeRecords().some((record) => record.run_id === runId && Option.isSome(record.ending)),
      "the hub to record the cancel it means",
      30_000,
    );
    await killDaemon();
    cancel.kill("SIGKILL");

    expect(alive(spoke)).toBe(true);

    await startDaemon();

    await waitFor(() => finished(issue).length > 0, "the run to end", 60_000);
    // Long enough for a tick to have started a run, had anything taken it up.
    await Bun.sleep(6000);

    expect(finished(issue)).toEqual([{ runId, status: "cancelled" }]);
    expect(ranIn(issue)).toHaveLength(1);
    expect(alive(spoke)).toBe(false);
    expect(existsSync(journalOf(runId))).toBe(false);
  }, 180_000);
});
