// One daemon as two GitHub personas: each tick acts as its persona, and the
// run that takes the work acts on GitHub, and in its agent session, as it.

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { BOT } from "./fake-github.ts";
import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const CreatedPull = Schema.Struct({ number: Schema.Finite });

describe("personas", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(() => {
    sandbox = openSandbox(
      {
        reviewers: ["alice", "bob"],
        flows: {
          review: { schedule: "*/2 * * * * *", agent: "codex" },
          implement: { enabled: false },
          "address-review": { enabled: false },
          "re-review": { enabled: false },
        },
      },
      { github: ["alice", "bob"], personas: ["alice", "bob"] },
    );
  });

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("the persona whose review is requested reviews, as itself, and the other leaves it alone", async () => {
    await sandbox.runCli(["trust", "demo"]);
    sandbox.git(sandbox.checkout, "checkout", "-qb", "feature");
    sandbox.git(sandbox.checkout, "commit", "-q", "--allow-empty", "-m", "feat: by a person");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "feature");

    const response = await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls`, {
      method: "POST",
      body: JSON.stringify({ head: "feature", base: "main", title: "feat: by a person", body: "" }),
    });

    const { number } = Schema.decodeUnknownSync(CreatedPull)(await response.json());
    sandbox.github.pull(number).reviewers.push("bob");
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");

    await waitFor(() => sandbox.github.reviewsOf(number).length > 0, "bob's review", 45_000);

    expect(sandbox.github.reviewsOf(number).map((review) => review.author)).toEqual(["bob"]);
    expect(sandbox.daemonLog()).toContain("acting on GitHub as alice, bob");
    expect(sandbox.daemonLog()).toMatch(
      new RegExp(`started [\\da-f-]{36} \\(demo/review pr-${number} as bob\\)`),
    );

    // Nothing the run did on GitHub was as anyone else.
    const onThePull = sandbox.github.requestsBy.filter(
      (request) => request.includes(`/pulls/${number}/reviews`) && request.includes(" POST "),
    );

    expect(onThePull.every((request) => request.startsWith("bob "))).toBe(true);

    // The agent session had bob's token; gh never saw the daemon's own GH_TOKEN.
    expect(sandbox.agentTokens()).toContain("codex token-bob");
    expect(sandbox.agentTokens().some((line) => line.endsWith("test-token"))).toBe(false);
    expect(sandbox.ghCalls().some((call) => call.includes("--user bob"))).toBe(true);
    expect(sandbox.ghCalls().some((call) => call.includes("with GH_TOKEN set"))).toBe(false);

    // Its id is random; the start of it, as status shows it, names the run.
    const runId =
      new RegExp(`started ([\\da-f-]{36}) \\(demo/review pr-${number} as bob\\)`).exec(
        sandbox.daemonLog(),
      )?.[1] ?? "";

    const logs = await sandbox.runCli(["logs", runId.slice(0, 8)]);
    expect(logs.code).toBe(0);
    expect(logs.output).toContain("step: ");

    const status = (await sandbox.runCli(["status"])).output;
    expect(status).toContain(`${runId.slice(0, 8)}  demo/review pr-${number} as bob`);
    expect(status).toContain("review as alice:");
    expect(status).toContain("review as bob:");
    expect(sandbox.github.pull(number).author).toBe(BOT);
  }, 60_000);

  test("doctor checks each persona's login, and that pushes can go out as it", async () => {
    const said = (await sandbox.runCli(["doctor"])).output;
    expect(said).toContain("✓ gh is logged in as alice (GitHub says: alice)");
    expect(said).toContain("✓ gh is logged in as bob (GitHub says: bob)");
    // Each reviewer persona on the machine can merge, since it merges what it approves on the automated path.
    expect(said).toContain("✓ demo: reviewer alice can merge in dataquail/demo (write)");
    sandbox.github.readOnly.add("bob");
    expect((await sandbox.runCli(["doctor"])).output).toContain(
      "✗ demo: reviewer bob can merge in dataquail/demo (read)",
    );
    // The sandbox's origin is a local path, not https.
    expect(said).toMatch(
      /✗ demo: origin is https \(.*origin\.git\), so each persona pushes as itself/,
    );
  });

  test("run names a persona when the flow runs as several", async () => {
    const refused = await sandbox.runCli(["run", "review", "--repo", "demo", "--detach"]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("demo runs review as alice, bob; name one with --as");
  });
});
