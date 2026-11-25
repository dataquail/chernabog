// The daemon as a hub (ADR 23, #659), through the real CLI against the fake
// GitHub: each run it starts executes in a spoke, a child process of its own,
// which the machine's concurrency counts; the run ends as its spoke reported
// once the spoke has exited. A daemon that stops ends its spokes, and the
// next one ends their runs as interrupted, so their phases repeat in new runs
// from what the ledger recorded.

import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Takes the issue's claim, says on the issue which process it runs in and
// which phase the ledger had for the item, then records its phase. An issue
// titled "hold ..." with no phase yet holds the run in a long step, so a test
// can stop the daemon under it; one titled "slow ..." takes a few seconds,
// saying when it started and ended. The flow takes its label off once done,
// so its trigger offers each issue until a run gets that far.
const HUB = `import { activity, Claims, defineFlow, GitHub, Implement, Issue, Phases, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export default defineFlow({
  concurrency: 2,
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("hub");

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

      if (title.startsWith("hold") && before === "none") {
        yield* activity("hold", Effect.sleep("60 seconds"));
      }

      if (title.startsWith("slow")) {
        const started = yield* activity("started", Effect.sync(() => Date.now()), Schema.Number);
        yield* activity("slow", Effect.sleep("3 seconds"));
        const ended = yield* activity("ended", Effect.sync(() => Date.now()), Schema.Number);
        yield* Issue.comment(issue, \`ran \${started}-\${ended}\`);
      }

      yield* activity("unlabel", Effect.flatMap(GitHub, (github) => github.removeLabel(issue, "hub")));

      return \`worked in \${pid}\`;
    }),
});
`;

const claimRef = (issue: number) => `refs/chernabog/claims/issue-${issue}`;

// Whether a process is alive, by its PID: `kill -0` reaches it.
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

describe("the daemon as a hub of spokes", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;
  let daemonExit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox.home, "daemon.sock");

  const startDaemon = async () => {
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

  const stopDaemon = async () => {
    if (Option.isNone(Option.fromNullishOr(daemon.exitCode))) {
      daemon.kill("SIGTERM");
    }

    await daemonExit;
  };

  const daemonPid = async () =>
    DaemonStatus.pipe(Schema.decodeUnknownSync)(
      await (await fetch("http://daemon/status", { unix: socket() })).json(),
    ).pid;

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

  // The runs of an issue the daemon logged finishing, and how.
  const finished = (issue: number) =>
    [
      ...sandbox
        .daemonLog()
        .matchAll(
          new RegExp(`finished ([\\da-f-]{36}) \\(demo/hub issue-${issue}\\): ([a-z-]+)`, "g"),
        ),
    ].map((found) => ({ runId: String(found[1]), status: String(found[2]) }));

  // When the issue's slow run started and ended, as it said.
  const span = (issue: number) =>
    Option.getOrThrow(
      Arr.findFirst(commentsOn(issue), (body) =>
        Option.map(Option.fromNullishOr(/^ran (\d+)-(\d+)$/.exec(body)), (said) => ({
          started: Number(said[1]),
          ended: Number(said[2]),
        })),
      ),
    );

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      {
        flows: { hub: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/hub.ts": HUB },
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

  test("runs a flow in a spoke of its own, and ends the run as the spoke said", async () => {
    const issue = sandbox.github.addIssue("done in one phase", ["hub"]);

    await waitFor(() => finished(issue).length > 0, "the run to finish", 60_000);

    const ran = Option.getOrThrow(Arr.head(ranIn(issue)));
    const run = Option.getOrThrow(Arr.head(finished(issue)));

    // It ran in a child process the daemon spawned, not in the daemon.
    expect(ran.pid).not.toBe(await daemonPid());
    expect(sandbox.daemonLog()).toContain(`spawned spoke ${ran.pid} for ${run.runId.slice(0, 8)}`);
    expect(run.status).toBe("done");
    // Its ending released its claim, and its journal and hand-over are gone.
    await waitFor(
      () => Option.isNone(sandbox.github.refSha(claimRef(issue))),
      "the claim to be released",
    );
    expect(existsSync(join(sandbox.home, "journals", `${run.runId}.db`))).toBe(false);
    expect(readdirSync(join(sandbox.home, "spokes"))).toEqual([]);
  }, 90_000);

  test("keeps no more spokes live than the machine's concurrency", async () => {
    const first = sandbox.github.addIssue("slow one", ["hub"]);
    const second = sandbox.github.addIssue("slow two", ["hub"]);

    await waitFor(
      () => finished(first).length > 0 && finished(second).length > 0,
      "both runs to finish",
      90_000,
    );

    const [earlier, later] = [span(first), span(second)].toSorted((x, y) => x.started - y.started);

    // The flow allows two at once; the machine's concurrency, one.
    expect(Option.getOrThrow(Option.fromUndefinedOr(later)).started).toBeGreaterThanOrEqual(
      Option.getOrThrow(Option.fromUndefinedOr(earlier)).ended,
    );
    expect(finished(first).map((run) => run.status)).toEqual(["done"]);
    expect(finished(second).map((run) => run.status)).toEqual(["done"]);
  }, 120_000);

  test("a daemon that stops ends its spoke, and the next repeats the run's phase from its record", async () => {
    const issue = sandbox.github.addIssue("hold until the daemon stops", ["hub"]);

    await waitFor(
      () =>
        ranIn(issue).length > 0 &&
        sandbox.github.dispatches.some((sent) => sent.item === `issue-${issue}`),
      "the spoke to record the issue's phase",
      60_000,
    );

    const held = Option.getOrThrow(Arr.head(ranIn(issue)));
    expect(held.before).toBe("none");
    expect(alive(held.pid)).toBe(true);

    await stopDaemon();
    await waitFor(() => !alive(held.pid), "the spoke to end with the daemon", 30_000);

    await startDaemon();

    // The run the stopped daemon left ends as interrupted, letting its claim
    // go; a new run takes the item up from the phase its record holds.
    await waitFor(
      () => finished(issue).some((run) => run.status === "done"),
      "a new run to finish the item",
      90_000,
    );

    expect(finished(issue).map((run) => run.status)).toEqual(["interrupted", "done"]);
    expect(ranIn(issue).map((ran) => ran.before)).toEqual(["none", "working"]);
    expect(ranIn(issue).map((ran) => ran.pid)).not.toContain(await daemonPid());
  }, 180_000);
});
