// A CI job ends while its pull request's CI runs (#513), through the real CLI
// against the fake GitHub, each job on a runner of its own as alice. The
// implement job opens the pull request, records the wait on the issue and
// ends. A plan woken by the finished CI run (workflow_run) holds the issue
// while CI is pending, and starts implement on it again once it settles; that
// job hands the pull request off without implementing the issue again. Then
// bob, on his laptop, asks for changes; address-review in CI pushes the fix
// and ends its job on the fix's pending CI, and a later job asks bob again.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Json } from "@chernabog/sdk";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox } from "./sandbox.ts";

const Matrix = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ flow: Schema.String, persona: Schema.String, item: Schema.String })),
);

describe("a CI job waiting on its pull request's CI", () => {
  let sandbox: Sandbox;
  let jobs = 0;
  let issue = 0;

  // A runner's own directory, with an event file and the files a step writes.
  const runner = (name: string, event: Json) => {
    jobs += 1;
    const job = join(sandbox.root, `job-${jobs}-${name}`);
    const user = join(job, "user");
    mkdirSync(user, { recursive: true });

    const files = {
      event: join(job, "event.json"),
      output: join(job, "github-output"),
      summary: join(job, "summary.md"),
    };

    writeFileSync(files.event, JSON.stringify(event));
    writeFileSync(files.output, "");
    writeFileSync(files.summary, "");

    return { job, user, ...files };
  };

  const runnerEnv = (job: ReturnType<typeof runner>, eventName: string, workspace: string) => ({
    CHERNABOG_HOME: join(job.job, "home"),
    HOME: job.user,
    GITHUB_ACTIONS: "true",
    // chernabog's own workflow, whose runs never wake a flow: not the repo's
    // CI that the events below finish, whatever the runner running this sets.
    GITHUB_WORKFLOW: "chernabog",
    GITHUB_REPOSITORY: "dataquail/demo",
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: job.output,
    GITHUB_STEP_SUMMARY: job.summary,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: job.event,
    GH_TOKEN: "token-alice",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
  });

  // The plan job for this event, and the run jobs it starts.
  const plan = async (name: string, eventName: string, event: Json) => {
    const job = runner(name, event);

    const planned = await sandbox.runCli(
      ["ci", "plan"],
      runnerEnv(job, eventName, sandbox.checkout),
    );

    const items = Option.getOrThrow(
      Option.fromNullishOr(/^items=(.*)$/m.exec(readFileSync(job.output, "utf8"))?.[1]),
    );

    return {
      ...planned,
      matrix: Schema.decodeSync(Matrix)(items),
      summary: readFileSync(job.summary, "utf8"),
    };
  };

  // A run job for one entry of a plan's matrix, in a fresh checkout and home.
  const run = async (entry: { flow: string; persona: string; item: string }) => {
    const job = runner(`run-${entry.flow}`, {});
    const checkout = join(job.job, "checkout");
    execFileSync("git", ["clone", "-q", sandbox.bare, checkout]);
    // The sandbox's machine config, enrolling this checkout, as ci run's own
    // tests give a job: its agents answer under the sandbox's launcher.
    mkdirSync(join(job.job, "home"), { recursive: true });
    writeFileSync(
      join(job.job, "home", "config.yaml"),
      readFileSync(join(sandbox.home, "config.yaml"), "utf8").replaceAll(
        sandbox.checkout,
        checkout,
      ),
    );

    return sandbox.runCli(
      ["ci", "run", "--flow", entry.flow, "--persona", entry.persona, "--item", entry.item],
      runnerEnv(job, "repository_dispatch", checkout),
    );
  };

  // A CI run of the repo's own workflow finished on the issue's branch.
  const ciFinished = (name: string) =>
    plan(name, "workflow_run", {
      action: "completed",
      workflow_run: { name: "CI", head_branch: `auto/issue-${issue}`, conclusion: "success" },
    });

  const phasesOf = (item: string) =>
    sandbox.github.dispatches.filter((sent) => sent.item === item).map((sent) => sent.to);

  beforeAll(async () => {
    sandbox = openSandbox(
      {
        reviewers: ["bob"],
        flows: { review: { agent: "codex" } },
        ci: { flows: ["implement", "address-review"] },
      },
      {
        github: ["alice", "bob"],
        personas: ["alice", "bob"],
        personaFlows: { alice: { implement: {}, "address-review": {} }, bob: { review: {} } },
      },
    );
    await sandbox.installCheckout();
    await sandbox.runCli(["trust", "demo"]);
    sandbox.github.setChecks("pending");
    issue = sandbox.github.addIssue("Waits on CI", ["auto:eligible"]);
  }, 120_000);

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("implement opens the pull request and ends the job, recording the wait on the issue", async () => {
    const labelled = await plan("labelled", "issues", {
      action: "labeled",
      label: { name: "auto:eligible" },
      issue: { number: issue },
      sender: { login: "bob" },
    });

    expect(labelled.matrix).toEqual([
      { flow: "implement", persona: "alice", item: `issue-${issue}` },
    ]);

    const first = await run(labelled.matrix[0] ?? { flow: "", persona: "", item: "" });

    expect(first.code).toBe(0);
    expect(first.output).toContain("parked");
    expect(sandbox.claudeCalls()).toHaveLength(1);

    const pull = Option.getOrThrow(sandbox.github.firstPull());
    expect(pull.reviewers).toEqual([]);
    expect(phasesOf(`issue-${issue}`)).toEqual(["awaiting-ci"]);
    expect(phasesOf(`pr-${pull.number}`)).toEqual([]);
  }, 180_000);

  test("a finished CI run while the checks still pend starts nothing, and says the issue waits on CI", async () => {
    const pending = await ciFinished("still-pending");

    expect(pending.code).toBe(0);
    expect(pending.matrix).toEqual([]);
    expect(pending.summary).toContain("waits on CI");
  }, 120_000);

  test("once CI is green, the finished CI run starts implement again, which hands the pull request off", async () => {
    sandbox.github.setChecks("green");
    const green = await ciFinished("green");

    expect(green.matrix).toEqual([{ flow: "implement", persona: "alice", item: `issue-${issue}` }]);

    const second = await run(green.matrix[0] ?? { flow: "", persona: "", item: "" });
    const pull = Option.getOrThrow(sandbox.github.firstPull());

    expect(second.code).toBe(0);
    expect(second.output).toContain("is ready for review");
    // Not implemented again: the agent ran once, in the first job.
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(sandbox.github.pull(pull.number).reviewers).toEqual(["bob"]);
    expect(phasesOf(`issue-${issue}`)).toEqual(["awaiting-ci", "handed-off"]);
    expect(phasesOf(`pr-${pull.number}`)).toEqual(["review-asked"]);
  }, 180_000);

  // The plan job for a phase announcement, as the daemon sends one.
  const announced = (item: string, from: string, to: string) =>
    plan(`phase-${to}`, "repository_dispatch", {
      action: "chernabog-phase",
      client_payload: { item, from, to },
    });

  test("address-review pushes its fix and ends the job on the fix's pending CI", async () => {
    const pull = Option.getOrThrow(sandbox.github.firstPull());
    // bob reviews on his laptop, and asks for changes.
    const review = await sandbox.runCli(["run", "review", "--repo", "demo", "--as", "bob"]);

    expect(review.code).toBe(0);
    expect(phasesOf(`pr-${pull.number}`)).toEqual(["review-asked", "changes-asked"]);

    sandbox.github.setChecks("pending");
    const changes = await announced(`pr-${pull.number}`, "review-asked", "changes-asked");

    expect(changes.matrix).toHaveLength(1);
    expect(changes.matrix[0]?.flow).toBe("address-review");

    const calls = sandbox.claudeCalls().length;
    const fixed = await run(changes.matrix[0] ?? { flow: "", persona: "", item: "" });

    expect(fixed.code).toBe(0);
    expect(fixed.output).toContain("parked");
    expect(sandbox.claudeCalls().length).toBeGreaterThan(calls);
    expect(phasesOf(`pr-${pull.number}`)).toEqual([
      "review-asked",
      "changes-asked",
      "awaiting-fix-ci",
    ]);
    expect(sandbox.github.pull(pull.number).reviewers).toEqual([]);
  }, 180_000);

  test("once the fix's CI is green, the finished CI run starts address-review again, which asks bob again", async () => {
    const pull = Option.getOrThrow(sandbox.github.firstPull());
    const pending = await ciFinished("fix-pending");

    expect(pending.matrix).toEqual([]);
    expect(pending.summary).toContain("waits on CI");

    sandbox.github.setChecks("green");
    const green = await ciFinished("fix-green");

    expect(green.matrix).toHaveLength(1);
    expect(green.matrix[0]?.flow).toBe("address-review");
    expect(green.matrix[0]?.item).toStartWith(`pr-${pull.number}-awaiting-fix-ci-`);

    const calls = sandbox.claudeCalls().length;
    const resumed = await run(green.matrix[0] ?? { flow: "", persona: "", item: "" });

    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain("asked bob to review again");
    expect(sandbox.claudeCalls()).toHaveLength(calls);
    expect(sandbox.github.pull(pull.number).reviewers).toEqual(["bob"]);
    expect(phasesOf(`pr-${pull.number}`).at(-1)).toBe("review-asked-again");
  }, 180_000);
});
