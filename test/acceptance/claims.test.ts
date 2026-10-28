// Claims as refs of their own (#133), through the real CLI against the fake
// GitHub: two machines after one issue, a claim let go with the work kept, and
// a branch nobody claims taken up as work.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const claimRef = (issue: number) => `refs/chernabog/claims/issue-${issue}`;

describe("two machines after one issue", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("the one that creates the claim ref holds it; the other skips the issue", async () => {
    const issue = sandbox.github.addIssue("Wanted twice", ["auto:eligible"]);
    const hang = join(sandbox.root, "hang-once");
    writeFileSync(hang, "");

    const first = sandbox.cli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_HANG_ONCE: hang,
    });

    await waitFor(
      () => sandbox.claudeCalls().length === 1 && !existsSync(hang),
      "the first machine's agent to start",
    );

    // Search can be stale: the second machine still finds the issue queued.
    sandbox.github.issue(issue).labels.push("auto:eligible");
    const other = sandbox.anotherMachine("b");
    const { output } = await other.runCli(["run", "implement", "--repo", "demo"]);

    // Its own process group, never `-0`: that would be this test runner's group.
    process.kill(-Option.getOrThrow(Option.fromUndefinedOr(first.pid)), "SIGKILL");
    await closed(first);

    expect(output).toContain(`#${issue} is already claimed`);
    expect(output).toContain(`holds ${claimRef(issue)}`);
    expect(sandbox.claudeCalls()).toHaveLength(1);

    const held = Option.getOrThrow(sandbox.github.refSha(claimRef(issue)));
    const message = sandbox.github.messageOf(held);
    expect(message).toStartWith("chernabog claim");
    expect(message).toContain("Flow: implement");
  }, 90_000);
});

describe("a claim ref", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("goes when the run ends, and the branch and pull request stay", async () => {
    const issue = sandbox.github.addIssue("Let go after", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain(`done: #${issue}:`);
    expect(code).toBe(0);

    expect(sandbox.github.requests).toContain("POST /repos/dataquail/demo/git/commits");
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
    expect(Option.isSome(sandbox.github.refSha(`refs/heads/auto/issue-${issue}`))).toBe(true);
    expect(Option.map(sandbox.github.firstPull(), (pull) => pull.state)).toEqual(
      Option.some("open"),
    );
  }, 60_000);

  test("is all a branch with no claim on it needs: the run takes it up as its work", async () => {
    const issue = sandbox.github.addIssue("Started by hand", ["auto:eligible"]);
    const branch = `auto/issue-${issue}`;
    execFileSync("git", ["--git-dir", sandbox.bare, "update-ref", `refs/heads/${branch}`, "main"]);

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain(`done: #${issue}:`);
    expect(code).toBe(0);

    const pull = [...sandbox.github.pulls.values()].find((found) => found.head === branch);
    expect(pull?.state).toBe("open");
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
  }, 60_000);
});

// The implement recipe as a repo baked it before claims were refs: it claims,
// but never lets the claim go.
const RELEASING = "        Claims.releasing(Claims.issue(issue)),\n";

const unreleasing = readFileSync(
  new URL("../../packages/recipes/flows/implement.ts", import.meta.url),
  "utf8",
).replace(RELEASING, "");

describe("a flow baked before claims were refs", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox({}, { repoFiles: { "flows/implement.ts": unreleasing } });
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("leaves its claim ref when the run ends, which cancel then lets go", async () => {
    expect(unreleasing).not.toContain("Claims.releasing");
    const issue = sandbox.github.addIssue("Claimed by an old flow", ["auto:eligible"]);
    expect((await sandbox.runCli(["run", "implement", "--repo", "demo"])).output).toContain(
      `done: #${issue}:`,
    );

    const left = Option.getOrThrow(sandbox.github.refSha(claimRef(issue)));
    const runId = /^Run: (.+)$/m.exec(sandbox.github.messageOf(left))?.[1] ?? "";

    // Queued again, the issue is held by the ended run's claim.
    sandbox.github.issue(issue).labels.push("auto:eligible");
    const held = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(held.output).toContain(`holds ${claimRef(issue)}`);

    const cancelled = await sandbox.runCli(["cancel", runId.slice(0, 8)]);
    expect(cancelled.output).toContain("had already ended (done), and keeps its ending");
    expect(cancelled.output).toContain(`deleted its claim ref ${claimRef(issue)}`);
    expect(cancelled.code).toBe(0);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());

    // With nothing left to let go of, it is refused as before.
    expect((await sandbox.runCli(["cancel", runId.slice(0, 8)])).code).not.toBe(0);

    const again = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(again.output).toContain(`done: #${issue}:`);
  }, 120_000);
});
