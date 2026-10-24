// `chernabog rehearse` (#115): a flow end to end through the real CLI, on a
// seeded repo, with stand-ins where the agent would be. The sandbox's fake
// GitHub serves one repo, the enrolled one, so these rehearse on it with
// enrolled: true; a scratch repo goes through the same calls.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import YAML from "yaml";

import { type ScenarioFile } from "../../src/kernel/scenario.value-object.ts";
import { openSandbox, type Sandbox } from "./sandbox.ts";

// Only by `chernabog trigger`.
const never = { schedule: "0 0 1 1 *" };

// Commits the change the sandbox's local gate looks for, and answers as implement's agent would.
const IMPLEMENT = [
  "echo change > change-1.txt",
  "git add change-1.txt",
  'git -c user.name=Rehearsal -c user.email=rehearsal@example.com commit -qm "feat: fix the button"',
  `echo '{"status":"done","title":"feat: fix the button","body":"Fixes the button.","summary":"Fixed the button."}'`,
].join(" && ");

const scenario = (sandbox: Sandbox, name: string, fields: Partial<ScenarioFile>) => {
  const path = join(sandbox.root, `${name}.yaml`);

  writeFileSync(
    path,
    YAML.stringify({
      repo: "dataquail/demo",
      enrolled: true,
      given: {
        issues: [{ name: "bug", title: "The button does nothing", labels: ["auto:eligible"] }],
      },
      ...fields,
    }),
  );

  return path;
};

const rehearse = (sandbox: Sandbox, path: string, ...extra: Array<string>) =>
  sandbox.runCli(["rehearse", "implement", "--repo", "demo", "--scenario", path, ...extra]);

describe("chernabog rehearse implement, as a single persona that authors", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox(
      { reviewers: ["alice", "bob"] },
      { github: ["alice"], personas: ["alice"], personaFlows: { alice: { implement: never } } },
    );
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("seeds the issue, opens a real pull request, hands off, and starts no agent", async () => {
    const path = scenario(sandbox, "implement", {
      agent: { implement: { script: IMPLEMENT } },
      expect: { ends: "done", summary: "is ready for review" },
    });

    const { code, output } = await rehearse(sandbox, path);

    expect(output).toContain("paused it on this machine for the rehearsal");
    expect(output).toContain("seeded issue #1 (bug) on dataquail/demo");
    expect(output).toContain("rehearsal: implement answered by its stand-in");
    expect(output).toContain("ended done: #1:");
    expect(output).toContain("✓ ended as the scenario expects");
    // The pool less alice is bob, whom no persona here reviews as.
    expect(output).toContain("asks bob to review it, and no persona here reviews as bob");
    expect(code).toBe(0);

    expect(sandbox.claudeCalls()).toEqual([]);
    expect(sandbox.github.openedBy).toEqual(["alice opened #1"]);
    const pull = Option.getOrThrow(sandbox.github.firstPull());
    expect(pull.head).toBe("auto/issue-1");
    expect(pull.reviewers).toEqual(["bob"]);

    // Cleaned up: alice isn't an admin, so the issue is closed rather than deleted.
    expect(output).toContain("closed pull request #2");
    expect(output).toContain("deleted branch auto/issue-1");
    expect(output).toContain("closed issue #1");
    expect(pull.state).toBe("closed");
    expect(sandbox.github.issue(1).closed).toBe(true);

    // And the repo runs again here.
    expect((await sandbox.runCli(["status"])).output).not.toContain("paused");
  }, 120_000);

  test("a step with no stand-in fails the rehearsal, naming the step", async () => {
    const path = scenario(sandbox, "unanswered", { agent: {} });
    const { code, output } = await rehearse(sandbox, path, "--keep");

    expect(output).toContain("no stand-in for step implement");
    expect(output).toContain("kept what was seeded on dataquail/demo (issue #3 (bug))");
    expect(code).not.toBe(0);
    expect(sandbox.claudeCalls()).toEqual([]);
  }, 120_000);

  test("an answer that doesn't match the step's schema fails as a real agent's would", async () => {
    const path = scenario(sandbox, "malformed", {
      agent: { implement: { fixture: { status: "finished" } } },
    });

    const { code, output } = await rehearse(sandbox, path);

    expect(output).toContain("agent answer:");
    expect(code).not.toBe(0);
  }, 120_000);
});

describe("chernabog rehearse implement --replay", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("stands in with a real run's answers and commits, and names the stand-ins no step used", async () => {
    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);
    const real = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    const runId = /started ([0-9a-f-]{36})/.exec(real.output)?.[1] ?? "";
    expect(runId).not.toBe("");
    const agentRuns = sandbox.claudeCalls().length;

    // Placeholder commits carry no real change, so this gate takes them as they are.
    const path = scenario(sandbox, "replay", {
      localGate: ["true"],
      agent: { "renamed-step": { fixture: {} } },
    });

    const { code, output } = await rehearse(sandbox, path, "--replay", runId.slice(0, 8));

    expect(output).toContain(`replaying ${runId}: implement`);
    expect(output).toContain("ended done:");
    expect(output).toContain("no step asked for the stand-in renamed-step");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(agentRuns);
  }, 120_000);
});

describe("chernabog rehearse, on an enrolled repo it wasn't told it may use", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("refuses, and seeds nothing", async () => {
    const path = scenario(sandbox, "refused", { enrolled: false });
    const { code, output } = await rehearse(sandbox, path);

    expect(output).toContain("dataquail/demo is enrolled on this machine");
    expect(code).not.toBe(0);
    expect(sandbox.github.issues.size).toBe(0);
  }, 60_000);
});

describe("chernabog rehearse implement, where the other reviewer runs review here", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox(
      { reviewers: ["alice", "bob"] },
      {
        github: ["alice", "bob"],
        personas: ["alice", "bob"],
        personaFlows: { alice: { implement: never }, bob: { review: never } },
      },
    );

    sandbox.github.admins.add("alice");
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("says the review request is served, and deletes what it seeded", async () => {
    const path = scenario(sandbox, "served", {
      persona: "alice",
      agent: { implement: { script: IMPLEMENT } },
    });

    const { code, output } = await rehearse(sandbox, path);

    expect(output).toContain("asks bob to review it; bob reviews here");
    expect(output).toContain("deleted issue #1");
    expect(code).toBe(0);
    expect(sandbox.github.issues.size).toBe(0);
  }, 120_000);
});
