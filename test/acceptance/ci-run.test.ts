// `chernabog ci run` (#460), through the real CLI against the fake GitHub: one
// item on one runner, each job in a home of its own as a runner's is. A job
// ends where a run on a laptop would park, letting go of the claim with its
// work pushed; the next job, in a fresh home, takes the item's next phase. A
// killed job's claim runs out on the short CI lease, and the next job repeats
// the phase from its start. A claim held elsewhere, or an item its trigger no
// longer reports, ends the job cleanly.

import { type ChildProcess, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { USER_ID } from "./fake-github.ts";
import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Claims an issue labelled ci:park and, in its first phase, has the agent
// commit a change and waits on `go`; once the issue is labelled go, its
// trigger says so, and the run goes on to comment instead. The label stands
// in for the phase a review loop reads. Labelled ci:gone, the run deletes its
// branch on GitHub before it parks, as a merge would; labelled ci:fail, it
// fails after the agent's commit, before anything pushes it, so the engine
// deletes the branch it made as the run ends.
const PHASED = `import { awaitSignal, defineFlow, GitHub, Implement, Issue, reportAs, StepFailed } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("ci:park");

    return issues.map((issue) => {
      const item = Implement.issueItem(issue);
      const go = issue.labels.includes("go");

      const data = {
        ...item.data,
        go,
        gone: issue.labels.includes("ci:gone"),
        fail: issue.labels.includes("ci:fail"),
      };

      return { ...item, data, signals: go ? ["go"] : [] };
    });
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { base, branch } = yield* Implement.claim(issue);
      const worktree = yield* Implement.prepareWorktree(branch, { base });

      if (JSON.stringify(item.data).includes('"go":false')) {
        yield* Implement.implementWithAgent(issue, worktree, { base });

        if (JSON.stringify(item.data).includes('"fail":true')) {
          return yield* new StepFailed({ step: "phase", message: "failed on purpose" });
        }

        if (JSON.stringify(item.data).includes('"gone":true')) {
          yield* (yield* GitHub).deleteRef(\`refs/heads/\${branch}\`);
        }

        yield* awaitSignal(["go"], { id: "park", timeout: "1 day" });
      }

      yield* Issue.comment(issue, "went on with the work");

      return "second phase";
    }),
});
`;

const claimRef = (issue: number) => `refs/chernabog/claims/issue-${issue}`;

// What the bare origin has on a branch.
const filesOn = (bare: string, branch: string) =>
  execFileSync("git", ["--git-dir", bare, "ls-tree", "--name-only", branch], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");

describe("chernabog ci run", () => {
  let sandbox: Sandbox;
  let jobs = 0;

  // A checkout and a home of its own for each job, as a runner's are, with
  // the machine config the workflow gives it, enrolling that checkout.
  const jobHome = () => {
    jobs += 1;
    const job = join(sandbox.root, `job-${jobs}`);
    const home = join(job, "home");
    const checkout = join(job, "checkout");
    mkdirSync(home, { recursive: true });
    execFileSync("git", ["clone", "-q", sandbox.bare, checkout]);

    writeFileSync(
      join(home, "config.yaml"),
      readFileSync(join(sandbox.home, "config.yaml"), "utf8").replaceAll(
        sandbox.checkout,
        checkout,
      ),
    );

    return { home, logs: join(job, "logs") };
  };

  const ciArgs = (issue: number, logs: string, extra: ReadonlyArray<string> = []) => [
    "ci",
    "run",
    "--repo",
    "demo",
    "--flow",
    "phased",
    "--persona",
    "chernabog-bot",
    "--item",
    `issue-${issue}`,
    "--logs",
    logs,
    ...extra,
  ];

  const ciRun = (issue: number, extra: ReadonlyArray<string> = [], env = {}) => {
    const job = jobHome();

    return sandbox
      .runCli(ciArgs(issue, job.logs, extra), { CHERNABOG_HOME: job.home, ...env })
      .then((result) => ({ ...result, ...job }));
  };

  beforeAll(() => {
    sandbox = openSandbox(
      {},
      {
        flows: { phased: {} },
        repoFiles: { "flows/phased.ts": PHASED },
      },
    );
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("an item goes through two phases in two jobs, each ending at the boundary", async () => {
    const issue = sandbox.github.addIssue("Two phases", ["ci:park"]);
    const first = await ciRun(issue);

    expect(first.output).toContain("parked");
    expect(first.code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    // The claim is let go, so the event that settles the wait can start the next job.
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
    // The agent's commit is on the branch, which the runner took with it.
    expect(
      filesOn(sandbox.bare, `auto/issue-${issue}`).some((file) => file.startsWith("change-")),
    ).toBe(true);
    // The run log and the agent's transcript, for the artifact.
    const kept = readdirSync(first.logs, { recursive: true }).map(String);
    expect(kept.some((file) => file.endsWith(".log"))).toBe(true);
    expect(kept.some((file) => file.endsWith(".jsonl"))).toBe(true);

    sandbox.github.issue(issue).labels.push("go");
    const second = await ciRun(issue);

    expect(second.output).toContain("done: second phase");
    expect(second.code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(sandbox.github.commentsOn(issue).map((comment) => comment.body)).toContain(
      "went on with the work",
    );
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
  }, 120_000);

  test("on a runner, git answers github.com with the job's token and commits as its account", async () => {
    const issue = sandbox.github.addIssue("On a runner", ["ci:park"]);
    const user = join(sandbox.root, `runner-user-${issue}`);
    mkdirSync(user, { recursive: true });

    const job = await ciRun(issue, [], {
      GITHUB_ACTIONS: "true",
      HOME: user,
      CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
    });

    expect(job.code).toBe(0);
    expect(job.output).toContain("parked");

    const global = (key: string) =>
      execFileSync("git", ["config", "--file", join(user, ".gitconfig"), "--get", key], {
        encoding: "utf8",
      }).trim();

    const login = global("user.name");

    expect(login.length).toBeGreaterThan(0);
    expect(global("user.email")).toBe(`${USER_ID}+${login}@users.noreply.github.com`);
    expect(global("credential.https://github.com.helper")).toContain("$GH_TOKEN");
    // The agent's commit reached GitHub, and claude was seeded beside it.
    expect(
      filesOn(sandbox.bare, `auto/issue-${issue}`).some((file) => file.startsWith("change-")),
    ).toBe(true);
    expect(readdirSync(user)).toContain(".claude.json");
  }, 120_000);

  test("a killed job's claim runs out, and the next job repeats the phase from its start", async () => {
    const issue = sandbox.github.addIssue("Killed mid-phase", ["ci:park"]);
    const before = sandbox.claudeCalls().length;
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");
    const job = jobHome();

    const killed: ChildProcess = sandbox.cli(ciArgs(issue, job.logs, ["--lease-seconds", "2"]), {
      CHERNABOG_HOME: job.home,
      FAKE_CLAUDE_HOLD: hold,
    });

    await waitFor(() => sandbox.claudeCalls().length === before + 1, "the agent to start");
    // Its own process group, never `-0`: that would be this test runner's group.
    process.kill(-Option.getOrThrow(Option.fromUndefinedOr(killed.pid)), "SIGKILL");
    await closed(killed);
    rmSync(hold, { force: true });

    // The killed job's claim is still there until its short lease runs out.
    expect(Option.isSome(sandbox.github.refSha(claimRef(issue)))).toBe(true);
    await Bun.sleep(2500);

    const next = await ciRun(issue, ["--lease-seconds", "2"]);

    expect(next.output).toContain("parked");
    expect(next.code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(before + 2);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
  }, 120_000);

  test("stops before the job's time limit, letting go of the claim", async () => {
    const issue = sandbox.github.addIssue("Out of time", ["ci:park"]);
    const before = sandbox.claudeCalls().length;
    const hold = join(sandbox.root, "hold-long");
    writeFileSync(hold, "");

    const { code, output } = await ciRun(issue, ["--stop-after-seconds", "6"], {
      FAKE_CLAUDE_HOLD: hold,
    });

    rmSync(hold, { force: true });

    expect(sandbox.claudeCalls()).toHaveLength(before + 1);
    expect(output).toContain("stopped before the job's time limit");
    expect(code).toBe(1);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
  }, 60_000);

  test("a run that ended leaves the branch the engine deleted as it ended", async () => {
    const issue = sandbox.github.addIssue("Failed early", ["ci:park", "ci:fail"]);
    const { code, output } = await ciRun(issue);

    expect(output).toContain("failed");
    expect(code).toBe(1);
    expect(sandbox.github.refSha(`refs/heads/auto/issue-${issue}`)).toEqual(Option.none());
  }, 60_000);

  test("a park pushes no branch that's gone from GitHub", async () => {
    const issue = sandbox.github.addIssue("Merged away", ["ci:park", "ci:gone"]);
    const { code, output } = await ciRun(issue);

    expect(output).toContain("parked");
    expect(code).toBe(0);
    expect(sandbox.github.refSha(`refs/heads/auto/issue-${issue}`)).toEqual(Option.none());
  }, 60_000);

  test("a claim another run holds ends the job cleanly", async () => {
    const issue = sandbox.github.addIssue("Held elsewhere", ["ci:park"]);
    const before = sandbox.claudeCalls().length;

    const sha = sandbox.github.commit(
      [
        "chernabog claim",
        "",
        "Run: elsewhere-run",
        "Persona: alice",
        "Flow: phased",
        "Claimed-At: 2026-11-10T00:00:00.000Z",
        "Expires-At: 2999-01-01T00:00:00.000Z",
      ].join("\n"),
      [],
    );

    sandbox.github.setRef(claimRef(issue), sha);
    const { code, output } = await ciRun(issue);

    expect(output).toContain("another run got there first");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(before);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.some(sha));
  }, 60_000);

  test("an item whose phase moved since the plan ends the job cleanly", async () => {
    const issue = sandbox.github.addIssue("Moved on", []);
    const { code, output } = await ciRun(issue);

    expect(output).toContain("another run got there first");
    expect(code).toBe(0);
  }, 60_000);

  test("refuses to start with ANTHROPIC_API_KEY set, rather than bill per token", async () => {
    const issue = sandbox.github.addIssue("Billed per token", ["ci:park"]);
    const { code, output } = await ciRun(issue, [], { ANTHROPIC_API_KEY: "sk-ant-api-not-real" });

    expect(output).toContain("ANTHROPIC_API_KEY");
    expect(code).toBe(1);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
  }, 60_000);

  test("refuses a home that already has runs, which isn't a runner's", async () => {
    const issue = sandbox.github.addIssue("Used home", ["ci:park"]);
    const job = jobHome();
    writeFileSync(join(job.home, "state.db"), "");

    const { code, output } = await sandbox.runCli(ciArgs(issue, job.logs), {
      CHERNABOG_HOME: job.home,
    });

    expect(output).toContain("a home of its own");
    expect(code).toBe(1);
  }, 60_000);
});
