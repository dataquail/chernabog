// An implement run interrupted mid-phase is taken up again (ADR 23, decision
// 7; #665), through the real CLI and daemon against the fake GitHub. Its claim
// took the issue's queue label off; ending the run interrupted puts it back
// (core's Markers.requeue), so the next tick's trigger offers the issue, and a
// new run repeats the phase and finishes it.

import { type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

describe("an implement run interrupted mid-phase", () => {
  const daemons: Array<ChildProcess> = [];

  afterEach(() => {
    for (const daemon of daemons.splice(0)) {
      daemon.kill("SIGKILL");
    }
  });

  const startDaemon = async (sandbox: Sandbox, env: Readonly<Record<string, string>> = {}) => {
    const daemon = sandbox.cli(["daemon"], env);
    daemons.push(daemon);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon's socket");

    return daemon;
  };

  const stopDaemon = async (daemon: ChildProcess) => {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.on("close", resolve));
  };

  // The endings the daemon logged for the issue's implement runs, in order.
  const endings = (sandbox: Sandbox) =>
    [
      ...sandbox
        .daemonLog()
        .matchAll(/finished [\da-f-]{36} \(demo\/implement issue-1\): ([a-z-]+)/g),
    ].map((found) => String(found[1]));

  test("is taken up again by the next tick, once the hub that ended it put its queue label back", async () => {
    const sandbox = openSandbox({}, { flows: { implement: { schedule: "*/2 * * * * *" } } });
    await sandbox.runCli(["trust", "demo"]);
    const issue = sandbox.github.addIssue("Survive a restart", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");

    // The first daemon's run holds in its agent call until the daemon stops.
    const first = await startDaemon(sandbox, { FAKE_CLAUDE_HOLD: hold });
    await waitFor(() => sandbox.claudeCalls().length === 1, "the first run's agent call");
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:eligible");
    await stopDaemon(first);

    // The next ends that run as interrupted, which puts the queue label back,
    // and its next tick starts a run that repeats the phase and finishes.
    await startDaemon(sandbox);
    await waitFor(() => endings(sandbox).includes("done"), "a new run to finish the issue");

    expect(endings(sandbox)).toEqual(["interrupted", "done"]);
    expect(sandbox.claudeCalls()).toHaveLength(2);
    expect(sandbox.github.pulls.size).toBe(1);
  }, 90_000);
});
