// Cancelling a run in flight, end to end: with the daemon running and with it
// stopped, a parked run ends as cancelled, its worktree and claim go, and it
// stays cancelled across a restart.

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Claims an eligible issue, prepares its worktree, and waits on a signal no
// trigger reports, as a run waiting on a person would.
const PARKED = `import { awaitSignal, defineFlow, GitHub, Implement, Repo, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const repo = yield* Repo;
    const issues = yield* (yield* GitHub).queuedIssuesLabelled(repo.labels.eligible);

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      yield* Implement.prepareWorktree(branch);
      yield* awaitSignal(["never"], { id: "park", timeout: "1 day" });

      return "woke";
    }),
});
`;

describe("chernabog cancel", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;
  let daemonExit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox.home, "daemon.sock");

  const startDaemon = async () => {
    const started = sandbox.cli(["daemon"]);
    daemon = started;

    daemonExit = new Promise((resolve) => {
      started.on("close", (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), "the daemon's socket");
  };

  const stopDaemon = async () => {
    if (Option.isNone(Option.fromNullishOr(daemon.exitCode))) {
      daemon.kill("SIGTERM");
    }

    await daemonExit;
  };

  const status = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse((await sandbox.runCli(["status", "--json"])).output),
    );

  // The run in flight for an issue, once it's parked on its signal.
  const parkedOn = async (issue: number) => {
    const deadline = Date.now() + 45_000;

    while (Date.now() < deadline) {
      const { output } = await sandbox.runCli(["status", "--json"]);
      const now = Schema.decodeUnknownOption(DaemonStatus)(JSON.parse(output));

      const parked = Option.flatMap(now, (found) =>
        Option.fromUndefinedOr(
          found.active.find((run) => run.itemKey === `issue-${issue}` && run.parked),
        ),
      );

      if (Option.isSome(parked)) {
        return parked.value.id;
      }

      await Bun.sleep(250);
    }

    throw new Error(`timed out waiting for the run for #${issue} to park`);
  };

  const worktree = (issue: number) =>
    join(sandbox.home, "worktrees", "demo", `auto-issue-${issue}`);

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      {
        flows: { parked: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/parked.ts": PARKED },
      },
    );
    await sandbox.runCli(["trust", "demo"]);
  });

  afterAll(async () => {
    await stopDaemon();
    await sandbox.github.stop();
  });

  test("with the daemon running, ends a parked run and releases what it held", async () => {
    const issue = sandbox.github.addIssue("Park me", ["auto:eligible"]);
    await startDaemon();
    const runId = await parkedOn(issue);

    expect(sandbox.github.issue(issue).labels).toContain("auto:in-progress");
    expect(existsSync(worktree(issue))).toBe(true);

    const { code, output } = await sandbox.runCli(["cancel", runId.slice(0, 8)]);

    expect(code).toBe(0);
    expect(output).toContain(`cancelled ${runId}`);
    expect(output).toContain("its workflow stopped in the engine");
    expect(output).toContain(
      `released the claim on #${issue} and deleted branch auto/issue-${issue}`,
    );
    expect(output).toContain(`removed worktree ${worktree(issue)}`);
    expect(existsSync(worktree(issue))).toBe(false);
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:in-progress");
    expect(sandbox.github.issue(issue).assignees).toEqual([]);
    expect(sandbox.git(sandbox.bare, "branch", "--list", `auto/issue-${issue}`).trim()).toBe("");
    // Nothing said on the issue beyond its claim.
    expect(sandbox.github.commentsOn(issue).length).toBe(1);

    const now = await status();

    expect(now.active.some((run) => run.id === runId)).toBe(false);
    expect(now.recent.find((run) => run.id === runId)?.status).toBe("cancelled");
  }, 90_000);

  test("an unknown or finished run fails, and changes nothing", async () => {
    const finished = (await status()).recent[0]?.id ?? "";
    const again = await sandbox.runCli(["cancel", finished]);
    const unknown = await sandbox.runCli(["cancel", "nope"]);
    const noItem = await sandbox.runCli(["cancel", "demo", "issue-999"]);

    expect([again.code, unknown.code, noItem.code]).toEqual([1, 1, 1]);
    expect(again.output).toContain("already finished: cancelled");
    expect(unknown.output).toContain("no run nope");
    expect(noItem.output).toContain("no run in flight for demo issue-999");
  }, 30_000);

  test("with the daemon stopped, cancels by item, and the run stays cancelled when it starts", async () => {
    const issue = sandbox.github.addIssue("Park me too", ["auto:eligible"]);
    const runId = await parkedOn(issue);
    await stopDaemon();

    const { code, output } = await sandbox.runCli(["cancel", "dataquail/demo", `issue-${issue}`]);

    expect(code).toBe(0);
    expect(output).toContain(`cancelled ${runId}`);
    expect(output).toContain(`released the claim on #${issue}`);
    expect(existsSync(worktree(issue))).toBe(false);

    await startDaemon();
    // A few ticks, for anything that would resume it.
    await Bun.sleep(5000);
    const now = await status();

    expect(now.active.some((run) => run.id === runId)).toBe(false);
    expect(now.recent.find((run) => run.id === runId)?.status).toBe("cancelled");
    expect((await sandbox.runCli(["logs", runId])).output).toContain("cancelled by");
  }, 120_000);
});
