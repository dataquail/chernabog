// A spoke that exits before it says how its run ended (a SIGKILL from
// outside, a crash), under a hub that carries on (ADR 23, decision 2),
// through the real CLI and daemon against the fake GitHub. Its run ends
// interrupted, as after a hub's restart, so its issue goes back on its queue
// and a new run repeats the phase. A phase that crashes every time is
// repeated only until machine config's `spokes: silentExits` runs in a row
// have ended so (3 by default): the last ends failed, and the issue isn't
// offered again.

import { type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Takes the issue's claim, then its queue label, as implement's claim does,
// holding the marker that puts the label back should the run be interrupted;
// says so on the issue; then kills its own spoke, which says nothing more.
const CRASH = `import { activity, Claims, defineFlow, GitHub, Implement, Issue, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("crash");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      yield* activity("claim", Claims.acquire(item.key).pipe(Effect.asVoid));
      yield* activity("take-label", Implement.takeQueueLabel(issue, "crash"));
      yield* Issue.comment(issue, "about to crash");
      yield* activity(
        "crash",
        Effect.sync(() => {
          process.kill(process.pid, "SIGKILL");
        }),
      );

      return "never gets here";
    }),
});
`;

describe("a spoke that exits without saying how its run ended", () => {
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

  // The endings the daemon logged for a flow's runs of issue 1, in order.
  const endings = (sandbox: Sandbox, flow: string) =>
    [
      ...sandbox
        .daemonLog()
        .matchAll(new RegExp(`finished [\\da-f-]{36} \\(demo/${flow} issue-1\\): ([a-z-]+)`, "g")),
    ].map((found) => String(found[1]));

  // The PID of each spoke the hub recorded, which leads its process group.
  const spokePids = (sandbox: Sandbox) => {
    const db = new Database(join(sandbox.home, "state.db"), { readonly: true });
    const rows = db.query("SELECT pid FROM om_spokes").all();
    db.close();

    return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ pid: Schema.Finite })))(rows).map(
      (row) => row.pid,
    );
  };

  test("killed from outside, its run ends interrupted and a new run repeats the phase", async () => {
    const sandbox = openSandbox({}, { flows: { implement: { schedule: "*/2 * * * * *" } } });
    await sandbox.runCli(["trust", "demo"]);
    const issue = sandbox.github.addIssue("Survive a SIGKILL", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");

    // The run holds in its agent call; its spoke's whole group is killed.
    await startDaemon(sandbox, { FAKE_CLAUDE_HOLD: hold });
    await waitFor(() => sandbox.claudeCalls().length === 1, "the first run's agent call");
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:eligible");

    const [spoke] = spokePids(sandbox);
    process.kill(-Number(spoke), "SIGKILL");
    rmSync(hold);

    // The hub, still up, ends the run interrupted, which puts the queue label
    // back, and its next tick starts a run that repeats the phase.
    await waitFor(
      () => endings(sandbox, "implement").includes("done"),
      "a new run to finish the issue",
      60_000,
    );

    expect(endings(sandbox, "implement")).toEqual(["interrupted", "done"]);
    expect(sandbox.daemonLog()).toContain(
      "before it said how the run ended (1 of 3 in a row); its phase is left for a new run to repeat",
    );
    expect(sandbox.claudeCalls()).toHaveLength(2);
    expect(sandbox.github.pulls.size).toBe(1);
  }, 90_000);

  test("a phase that crashes every time is repeated 3 times in all, then ends failed and is left", async () => {
    const sandbox = openSandbox(
      {},
      {
        flows: { crash: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/crash.ts": CRASH },
      },
    );

    await sandbox.runCli(["trust", "demo"]);
    const issue = sandbox.github.addIssue("Crash every time", ["crash"]);

    await startDaemon(sandbox);
    await waitFor(
      () => endings(sandbox, "crash").includes("failed"),
      "the third crash to end failed",
      90_000,
    );

    // Long enough for several ticks to have started a run, had anything
    // offered the issue again.
    await Bun.sleep(8000);

    expect(endings(sandbox, "crash")).toEqual(["interrupted", "interrupted", "failed"]);
    expect(
      sandbox.github.commentsOn(issue).filter((comment) => comment.body === "about to crash"),
    ).toHaveLength(3);
    expect(sandbox.github.issue(issue).labels).not.toContain("crash");
    expect(sandbox.daemonLog()).toContain(
      "before it said how the run ended, 3 runs in a row of this item; it isn't repeated again until a person looks",
    );
  }, 150_000);
});
