// The daemon as a hub (ADR 23, #659), through the real CLI against the fake
// GitHub: each run it starts executes in a spoke, a child process of its own,
// which the machine's concurrency counts; the run ends as its spoke reported
// once the spoke has exited. A run that parks ends its spoke at the park,
// and the signal it waits on starts a new spoke from the phase it recorded,
// across a restart too (#660). A daemon that stops ends its spokes, and the
// next one ends their runs as interrupted, so their phases repeat in new runs
// from what the ledger recorded. The hub tails each spoke's journal and folds
// what it reports into state.db, so status and /events show a run's steps
// while its spoke runs (#661). A cancel ends the spoke and answers only once
// it has exited and its journal is gone, whatever its lanes are doing (#662).

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
// saying when it started and ended. One titled "park ..." parks on `go`,
// recording `waiting`: its trigger holds it there until the issue is
// labelled `go`, and then offers it, for a run that takes it up from that
// record. One titled "lanes ..." with no phase yet holds the run in two lanes
// at once, one in a step that never ends and one asleep on a durable clock
// (#675). The flow takes its label off once done, so its trigger offers each
// issue until a run gets that far.
const HUB = `import { activity, Claims, defineFlow, GitHub, Implement, Issue, Phases, reportAs, sleep } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export default defineFlow({
  concurrency: 2,
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("hub");

    return yield* Effect.forEach(issues, (issue) =>
      Effect.map(Phases.current(\`issue-\${issue.number}\`), (found) => {
        const item = Implement.issueItem(issue);
        const waits =
          Option.exists(found, (record) => record.phase === "waiting") &&
          !issue.labels.includes("go");

        return waits ? { ...item, held: "waits for go" } : item;
      }),
    );
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

      if (title.startsWith("park") && before !== "waiting") {
        yield* Phases.park({ step: "park", item: item.key, phase: "waiting", data: {} }, ["go"], "go");
      }

      if (title.startsWith("hold") && before === "none") {
        yield* activity("hold", Effect.sleep("60 seconds"));
      }

      if (title.startsWith("lanes") && before === "none") {
        yield* Effect.all([activity("stuck", Effect.never), sleep("nap", "5 seconds")], {
          concurrency: 2,
          discard: true,
        });
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

  test("status and /events show a spoke's step while it runs, from what it reported", async () => {
    const events = await fetch("http://daemon/events", { unix: socket() });
    const reader = (events.body ?? new ReadableStream()).getReader();
    let heard = "";
    // The read in flight, kept across waits so no chunk is dropped.
    let reading = reader.read();

    // What the stream has said by the time it says `text`, or by 60 seconds.
    const until = async (text: string) => {
      const deadline = Date.now() + 60_000;

      while (!heard.includes(text) && Date.now() < deadline) {
        const chunk = await Promise.race([
          reading.then((read) => Option.some(read.value)),
          Bun.sleep(1000).then(() => Option.none()),
        ]);

        for (const value of Option.toArray(chunk)) {
          heard += new TextDecoder().decode(value);
          reading = reader.read();
        }
      }

      return heard;
    };

    const issue = sandbox.github.addIssue("hold while status looks", ["hub"]);

    // The run in flight for the issue, as the hub's status has it.
    const inFlight = async () =>
      Arr.findFirst(
        DaemonStatus.pipe(Schema.decodeUnknownSync)(
          await (await fetch("http://daemon/status", { unix: socket() })).json(),
        ).active,
        (run) => run.itemKey === `issue-${issue}`,
      );

    let found = Option.none<{ readonly id: string; readonly step: Option.Option<string> }>();
    const deadline = Date.now() + 60_000;

    while (
      !Option.exists(found, (seen) => Option.contains(seen.step, "hold")) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(250);
      found = Option.map(await inFlight(), (seen) => ({ id: seen.id, step: seen.currentStep }));
    }

    const run = Option.getOrThrow(found);
    expect(run.step).toEqual(Option.some("hold"));
    const spoke = Option.getOrThrow(Arr.head(ranIn(issue)));

    // What status shows came from the spoke's journal while the spoke still
    // runs: it writes nothing to state.db, and the hub folded its reports.
    expect(alive(spoke.pid)).toBe(true);
    expect(await until(`"step":"hold"`)).toContain("event: RunEnteredStep");
    expect(heard).toContain(`"runId":"${run.id}","step":"claim"`);
    expect(heard).toContain(`"runId":"${run.id}","step":"hold"`);

    await reader.cancel();

    const cancelled = await sandbox.runCli(["cancel", run.id.slice(0, 8)]);
    expect(cancelled.code).toBe(0);
    await waitFor(() => !alive(spoke.pid), "the cancelled run's spoke to exit", 30_000);
  }, 120_000);

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

  // Takes the issue's label off, so its trigger offers it to no new run.
  const unlabel = (issue: number) => {
    const { labels } = sandbox.github.issue(issue);
    labels.splice(labels.indexOf("hub"), 1);
  };

  const journalOf = (runId: string) => join(sandbox.home, "journals", `${runId}.db`);

  test("cancel answers once the spoke has exited and its journal is gone, and a restarted daemon leaves the run cancelled", async () => {
    const issue = sandbox.github.addIssue("hold until cancelled", ["hub"]);
    const runId = await inStep(issue, "hold");
    const spoke = Option.getOrThrow(Arr.head(ranIn(issue)));
    expect(alive(spoke.pid)).toBe(true);
    expect(existsSync(journalOf(runId))).toBe(true);
    unlabel(issue);

    const cancelled = await sandbox.runCli(["cancel", runId.slice(0, 8)]);

    expect(cancelled.code).toBe(0);
    expect(cancelled.output).toContain(`cancelled ${runId}`);
    expect(cancelled.output).toContain("its journal is deleted");
    // By the time cancel answered, the spoke had exited and its journal was gone.
    expect(alive(spoke.pid)).toBe(false);
    expect(existsSync(journalOf(runId))).toBe(false);
    expect(Option.isNone(sandbox.github.refSha(claimRef(issue)))).toBe(true);
    expect(finished(issue)).toEqual([{ runId, status: "cancelled" }]);

    // A restarted daemon doesn't take the run up again: it stays cancelled,
    // and nothing runs for it.
    await stopDaemon();
    await startDaemon();
    await Bun.sleep(6000);

    expect(finished(issue)).toEqual([{ runId, status: "cancelled" }]);
    expect(ranIn(issue)).toHaveLength(1);
    expect(
      DaemonStatus.pipe(Schema.decodeUnknownSync)(
        await (await fetch("http://daemon/status", { unix: socket() })).json(),
      ).active.some((run) => run.id === runId),
    ).toBe(false);
  }, 180_000);

  test("cancel stops a run with one lane in a step and another asleep on a durable clock, within the grace (#675)", async () => {
    const issue = sandbox.github.addIssue("lanes held two ways", ["hub"]);
    const runId = await inStep(issue, "stuck");
    const spoke = Option.getOrThrow(Arr.head(ranIn(issue)));
    unlabel(issue);
    // Into the other lane's sleep, as #675's scratch run was.
    await Bun.sleep(600);

    const asked = Date.now();
    const cancelled = await sandbox.runCli(["cancel", runId.slice(0, 8)]);
    const took = Date.now() - asked;

    expect(cancelled.code).toBe(0);
    expect(alive(spoke.pid)).toBe(false);
    expect(existsSync(journalOf(runId))).toBe(false);
    // SIGTERM, then SIGKILL after 10 seconds at most, and the CLI's own start.
    expect(took).toBeLessThan(15_000);
    expect(finished(issue)).toEqual([{ runId, status: "cancelled" }]);
  }, 120_000);

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

  // Parks an issue's run, and waits until its spoke has ended the run at the
  // park and exited: the PID its run ran in.
  const parkedRun = async (issue: number) => {
    await waitFor(
      () => finished(issue).some((run) => run.status === "ended-at-park"),
      "the run to end at its park",
      60_000,
    );

    const parked = Option.getOrThrow(Arr.head(ranIn(issue)));
    await waitFor(() => !alive(parked.pid), "the parked run's spoke to exit", 30_000);

    return parked;
  };

  // The phases the issue's record moved to, as each advance announced it.
  const phasesOf = (issue: number) =>
    sandbox.github.dispatches
      .filter((sent) => sent.item === `issue-${issue}`)
      .map((sent) => sent.to);

  test("a run that parks ends its spoke, and its signal starts a new spoke from the phase it recorded", async () => {
    const issue = sandbox.github.addIssue("park on go", ["hub"]);
    const parked = await parkedRun(issue);

    expect(parked.before).toBe("none");
    expect(phasesOf(issue)).toEqual(["working", "waiting"]);
    // Its claim went with its run, so a run anywhere may take the item up.
    await waitFor(
      () => Option.isNone(sandbox.github.refSha(claimRef(issue))),
      "the parked run's claim to be released",
    );

    // Nothing runs for the item while it waits: its trigger holds it.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(ranIn(issue)).toHaveLength(1);

    sandbox.github.issue(issue).labels.push("go");

    await waitFor(
      () => finished(issue).some((run) => run.status === "done"),
      "a new run to take the item up",
      60_000,
    );

    const taken = ranIn(issue);
    expect(finished(issue).map((run) => run.status)).toEqual(["ended-at-park", "done"]);
    expect(taken.map((ran) => ran.before)).toEqual(["none", "waiting"]);
    // A spoke of its own, neither the parked run's nor the daemon.
    expect(new Set(taken.map((ran) => ran.pid)).size).toBe(2);
    expect(taken.map((ran) => ran.pid)).not.toContain(await daemonPid());
    // Both runs' journals went with them.
    expect(
      finished(issue).filter((run) =>
        existsSync(join(sandbox.home, "journals", `${run.runId}.db`)),
      ),
    ).toEqual([]);
  }, 180_000);

  test("a park outlasts the daemon: the next one starts the run that takes it up", async () => {
    const issue = sandbox.github.addIssue("park through a restart", ["hub"]);
    const parked = await parkedRun(issue);

    await stopDaemon();
    sandbox.github.issue(issue).labels.push("go");
    await startDaemon();

    await waitFor(
      () => finished(issue).some((run) => run.status === "done"),
      "the restarted daemon to take the item up",
      90_000,
    );

    const taken = ranIn(issue);
    expect(finished(issue).map((run) => run.status)).toEqual(["ended-at-park", "done"]);
    expect(taken.map((ran) => ran.before)).toEqual(["none", "waiting"]);
    expect(taken.map((ran) => ran.pid).slice(0, 1)).toEqual([parked.pid]);
    expect(new Set(taken.map((ran) => ran.pid)).size).toBe(2);
    expect(taken.map((ran) => ran.pid)).not.toContain(await daemonPid());
  }, 180_000);
});
