// The review loop end to end, through the daemon and GitHub's own review
// requests: alice, one persona, writes the pull request; bob, another on the
// same machine, is the team's reviewer. Nobody steps in.

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const CreatedPull = Schema.Struct({ number: Schema.Finite });

const often = { schedule: "*/2 * * * * *" };

describe("the review loop", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const pull = () => {
    const first = sandbox.github.firstPull();

    if (Option.isNone(first)) {
      throw new Error("no pull request yet");
    }

    return first.value;
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      {
        reviewers: ["alice", "bob"],
        flows: { review: { agent: "codex" }, "re-review": { agent: "codex" } },
      },
      {
        github: ["alice", "bob"],
        personas: ["alice", "bob"],
        personaFlows: {
          alice: { implement: often, "address-review": often },
          bob: { review: often, "re-review": often },
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

  test("alice implements an auto:ship issue, bob requests changes, alice's address-review fixes in her session, bob re-reviews in his and merges", async () => {
    sandbox.github.addIssue("Shipped work", ["auto:ship"]);
    await waitFor(() => sandbox.github.merges.length > 0, "the pull request to merge", 90_000);

    expect(pull().author).toBe("alice");
    expect(pull().labels).toContain("auto:ship");
    expect(sandbox.github.merges).toEqual([{ number: pull().number, method: "squash", by: "bob" }]);

    // Bob, never alice, its author, reviewed it: once asking for changes, once approving the fixed head.
    const [changes, approval] = sandbox.github.reviewsOf(pull().number);
    expect(
      sandbox.github.reviewsOf(pull().number).map((review) => `${review.author} ${review.state}`),
    ).toEqual(["bob CHANGES_REQUESTED", "bob APPROVED"]);
    expect(changes.comments[0]).toEqual({
      path: "README.md",
      line: 1,
      side: "RIGHT",
      body: "Mention the change here.",
    });
    expect(approval.commit_id).not.toBe(changes.commit_id);

    // Claude wrote it, then, in the same session, weighed the review and fixed it; Codex reviewed it in one session and resumed it to re-review.
    const claude = sandbox.claudeCalls();
    expect(claude.map((call) => call.split(" ")[0])).toEqual(["start", "resume", "resume"]);
    expect(new Set(claude.map((call) => call.split(" ")[1])).size).toBe(1);
    const codex = sandbox.codexCalls();
    expect(codex.map((call) => call.split(" ")[0])).toEqual(["start", "resume"]);
    expect(codex[1]?.split(" ")[1]).toBe(codex[0]?.split(" ")[1]);

    expect(sandbox.daemonLog()).toMatch(/started [\da-f-]{36} \(demo\/review pr-\d+ as bob\)/);
    expect(sandbox.daemonLog()).toMatch(
      /started [\da-f-]{36} \(demo\/address-review pr-\d+-changes-1 as alice\)/,
    );
    expect(sandbox.daemonLog()).toMatch(
      /started [\da-f-]{36} \(demo\/re-review pr-\d+-review-2 as bob\)/,
    );
    expect(existsSync(join(sandbox.home, `worktrees/demo/review-pr-${pull().number}`))).toBe(false);
    expect(pull().labels).not.toContain("auto:changes-requested");
    expect(pull().labels).not.toContain("auto:needs-human");
  }, 120_000);
});

describe("a pull request a person opened", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(() => {
    sandbox = openSandbox(
      {
        flows: {
          review: { ...often, agent: "codex" },
          implement: { enabled: false },
          "address-review": { enabled: false },
          "re-review": { enabled: false },
        },
      },
      { flows: { review: often } },
    );
  });

  afterAll(async () => {
    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("is reviewed once this machine's review is requested, and left for a person to merge", async () => {
    await sandbox.runCli(["trust", "demo"]);
    sandbox.git(sandbox.checkout, "checkout", "-qb", "feature");
    sandbox.git(sandbox.checkout, "commit", "-q", "--allow-empty", "-m", "feat: by a person");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "feature");

    // Opened by a person, carol, so the machine (the sandbox's bot) can review it.
    const response = await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls`, {
      method: "POST",
      headers: { authorization: "Bearer token-carol" },
      body: JSON.stringify({ head: "feature", base: "main", title: "feat: by a person", body: "" }),
    });

    const { number } = Schema.decodeUnknownSync(CreatedPull)(await response.json());
    sandbox.github.pull(number).reviewers.push("alice");
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");
    // Ticks every two seconds; a few of them leave the pull request to alice.
    await Bun.sleep(5000);
    expect(sandbox.github.reviewsOf(number)).toEqual([]);

    sandbox.github.pull(number).reviewers.push("chernabog-bot");
    await waitFor(
      () => sandbox.github.reviewsOf(number).length > 0,
      "the review once this machine is asked",
      45_000,
    );
    expect(
      sandbox.github.reviewsOf(number).map((review) => `${review.author} ${review.state}`),
    ).toEqual(["chernabog-bot CHANGES_REQUESTED"]);
    expect(sandbox.github.merges).toEqual([]);
    expect(sandbox.github.pull(number).reviewers).toEqual(["alice"]);
  }, 60_000);
});

describe("a review the author disputes", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(async () => {
    sandbox = openSandbox(
      {
        reviewers: ["bob"],
        flows: { review: { agent: "codex" }, "re-review": { agent: "codex" } },
      },
      {
        github: ["alice", "bob"],
        personas: ["alice", "bob"],
        personaFlows: {
          alice: { implement: often, "address-review": often },
          bob: { review: often, "re-review": often },
        },
      },
    );
    await sandbox.runCli(["trust", "demo"]);
    daemon = sandbox.cli(["daemon"], { FAKE_CLAUDE_CONSIDER: "decline" });
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");
  });

  afterAll(async () => {
    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("is answered with its reasons and handed to a person, with no push and no new review request", async () => {
    sandbox.github.addIssue("Disputed work", ["auto:ship"]);
    await waitFor(
      () =>
        Option.exists(sandbox.github.firstPull(), (first) =>
          first.labels.includes("auto:needs-human"),
        ),
      "the dispute to reach a person",
      60_000,
    );

    const [first] = [...sandbox.github.pulls.values()];
    const said = sandbox.github.commentsOn(first.number).map((comment) => comment.body);
    expect(
      said.some(
        (body) =>
          body.startsWith("Not addressing review 1:") && body.includes("The review is right"),
      ),
    ).toBe(true);
    expect(sandbox.github.reviewsOf(first.number).map((review) => review.state)).toEqual([
      "CHANGES_REQUESTED",
    ]);
    expect(first.reviewers).toEqual([]);
    expect(sandbox.github.merges).toEqual([]);
    // Nothing was pushed after the review: one commit, the implement run's.
    expect(sandbox.claudeCalls().map((call) => call.split(" ")[0])).toEqual(["start", "resume"]);
  }, 90_000);
});
