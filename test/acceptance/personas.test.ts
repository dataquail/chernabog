// One daemon as two GitHub personas: each tick acts as its persona, and the
// run that takes the work acts on GitHub, and in its agent session, as it.
// Setup errors stop a persona's flows before they do any work, and say how to
// fix them: a persona gh has no login for, and a reviewer without a seat in
// the team's pool. A flow that doesn't review runs whatever the seat.

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

const often = { schedule: "*/2 * * * * *" };

// Only by `chernabog trigger`.
const never = { schedule: "0 0 1 1 *" };

describe("setup errors, as personas", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(async () => {
    // alice reviews; carol is logged in but has no seat; dave isn't logged in at all.
    sandbox = openSandbox(
      { reviewers: ["alice"] },
      {
        github: ["alice", "carol", "dave"],
        loggedOut: ["dave"],
        personas: ["alice", "carol", "dave"],
        personaFlows: {
          alice: { review: never },
          carol: { review: never, implement: never },
          dave: { implement: often },
        },
      },
    );
    await sandbox.runCli(["trust", "demo"]);
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");
  });

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("a persona gh has no login for never starts its flow's work; the tick records why, with the fix, and status shows it", async () => {
    await waitFor(
      () => sandbox.daemonLog().includes("demo/implement@dave: skipped: dave is unavailable"),
      "dave's tick to skip",
    );

    expect(sandbox.daemonLog()).toContain("Fix: run `gh auth login --hostname github.com` as dave");
    expect(sandbox.daemonLog()).not.toMatch(/started .* as dave\)/);
    // Its trigger never ran: nothing on GitHub was asked as dave.
    expect(sandbox.github.requestsBy.some((request) => request.startsWith("dave "))).toBe(false);

    const status = (await sandbox.runCli(["status"])).output;
    expect(status).toContain(
      "demo/implement@dave: dave is unavailable: gh auth token --hostname github.com --user dave",
    );
    expect(status).toContain("Fix: run `gh auth login --hostname github.com` as dave");

    const triggered = await sandbox.runCli([
      "trigger",
      "implement",
      "--repo",
      "demo",
      "--as",
      "dave",
    ]);

    expect(triggered.output).toContain("dave is unavailable");
  }, 30_000);

  test("a review flow as a login outside reviewers records NotInReviewerPool; a flow that does not review runs", async () => {
    const reviewing = await sandbox.runCli([
      "trigger",
      "review",
      "--repo",
      "demo",
      "--as",
      "carol",
    ]);

    expect(reviewing.output).toContain(
      "carol has no seat in the reviewer pool (reviewers: alice). Fix: add carol to reviewers",
    );

    const implementing = await sandbox.runCli([
      "trigger",
      "implement",
      "--repo",
      "demo",
      "--as",
      "carol",
    ]);

    expect(implementing.output).not.toContain("seat");
    expect(implementing.output).toContain("nothing to start");

    const seated = await sandbox.runCli(["trigger", "review", "--repo", "demo", "--as", "alice"]);
    expect(seated.output).toContain("nothing to start");
  }, 30_000);
});

describe("setup errors, as the implicit account", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(async () => {
    sandbox = openSandbox(
      { reviewers: ["alice"], flows: { review: never, implement: never } },
      { flows: { review: never, implement: never } },
    );
    await sandbox.runCli(["trust", "demo"]);
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");
  });

  afterAll(async () => {
    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("a review flow records NotInReviewerPool, with the fix; implement does not", async () => {
    const reviewing = await sandbox.runCli(["trigger", "review", "--repo", "demo"]);
    expect(reviewing.output).toContain(
      "a flow that reviews runs as the implicit account, which has no seat in the reviewer pool (reviewers: alice)",
    );
    expect(reviewing.output).toContain(
      "Fix: run it as a persona under github: that the repo's reviewers list",
    );

    const status = (await sandbox.runCli(["status"])).output;
    expect(status).toContain("demo/review: a flow that reviews runs as the implicit account");

    const implementing = await sandbox.runCli(["trigger", "implement", "--repo", "demo"]);
    expect(implementing.output).toContain("nothing to start");
  }, 30_000);
});
