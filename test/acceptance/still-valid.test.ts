// Runs whose work item goes, end to end with the daemon (#142): a parked run
// whose issue a person closes ends as superseded within limits.validityEvery,
// its claim released and its reason shown; a run whose check fails carries on,
// and status shows the failure. A notification about the item ends it at once
// (#149).

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { BOT } from "./fake-github.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Claims an issue labelled `label`, prepares its worktree, and works for a
// long while, in flight: a run that parked would end at its park (ADR 0021).
// Its stillValid is `check`.
const parked = (label: string, check: string) => `import {
  defineFlow,
  GitHub,
  Implement,
  reportAs,
  sleep,
  StepFailed,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("${label}");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  stillValid: ${check},
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      yield* Implement.prepareWorktree(branch);
      yield* sleep("working", "1 day");

      return "woke";
    }),
});
`;

const FLAKY = `() => Effect.fail(new StepFailed({ step: "still-valid", message: "the vendor is down" }))`;

// Polls `check` until it holds, as waitFor does for a check that asks the daemon.
const eventually = async (check: () => Promise<boolean>, what: string, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await Bun.sleep(250);
  }
};

describe("a run whose work item goes", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const status = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse((await sandbox.runCli(["status", "--json"])).output),
    );

  // The run in flight for an issue, once it has claimed it.
  const parkedOn = async (issue: number) => {
    let found = Option.none<string>();

    await eventually(async () => {
      found = Option.fromUndefinedOr(
        (await status()).active.find(
          (run) =>
            run.itemKey === `issue-${issue}` &&
            sandbox.github.issue(issue).labels.includes("auto:in-progress"),
        )?.id,
      );

      return Option.isSome(found);
    }, `the run for #${issue} to claim it`);

    return Option.getOrThrow(found);
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      { limits: { validityEvery: "1 second" } },
      {
        flows: {
          parked: { schedule: "*/2 * * * * *", concurrency: 4 },
          flaky: { schedule: "*/2 * * * * *" },
        },
        // Runs in flight hold a slot each, as a parked run never did.
        concurrency: 4,
        recipes: [],
        repoFiles: {
          "flows/parked.ts": parked("auto:eligible", "Implement.stillValid"),
          "flows/flaky.ts": parked("flaky", FLAKY),
        },
      },
    );
    await sandbox.runCli(["trust", "demo"]);
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon's socket");
  }, 60_000);

  afterAll(async () => {
    daemon.kill("SIGTERM");
    await sandbox.github.stop();
  });

  test("a run in flight whose issue is closed ends as superseded, its claim released", async () => {
    const issue = sandbox.github.addIssue("Park me", ["auto:eligible"]);
    const runId = await parkedOn(issue);

    expect(sandbox.github.issue(issue).labels).toContain("auto:in-progress");
    sandbox.github.issue(issue).closed = true;

    await eventually(
      async () =>
        (await status()).recent.some((run) => run.id === runId && run.status !== "running"),
      `run ${runId} to end`,
    );

    const ended = (await status()).recent.find((run) => run.id === runId);

    expect(ended?.status).toBe("superseded");
    expect(Option.getOrElse(ended?.summary ?? Option.none(), () => "")).toMatch(
      new RegExp(`^#${issue} was closed; interrupted in `),
    );

    // The daemon records the run's ending before it stops the workflow and
    // lets go of what the run held, so the release can come a moment later.
    await eventually(
      async () =>
        !sandbox.github.issue(issue).labels.includes("auto:in-progress") &&
        Option.isNone(sandbox.github.refSha(`refs/chernabog/claims/issue-${issue}`)),
      `run ${runId} to let go of #${issue}`,
    );
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:in-progress");
    expect(sandbox.github.refSha(`refs/chernabog/claims/issue-${issue}`)).toEqual(Option.none());
    expect((await sandbox.runCli(["status"])).output).toContain(`#${issue} was closed`);
    expect((await sandbox.runCli(["logs", runId])).output).toContain(
      `superseded: #${issue} was closed`,
    );
  }, 90_000);

  test("a run whose check fails carries on, and status shows the failure", async () => {
    const issue = sandbox.github.addIssue("Flaky", ["flaky"]);
    const runId = await parkedOn(issue);

    await eventually(
      async () => ((await status()).validity ?? []).some((check) => check.runId === runId),
      `run ${runId}'s check to fail`,
    );

    const now = await status();

    expect(now.active.some((run) => run.id === runId)).toBe(true);
    expect(now.validity?.find((check) => check.runId === runId)?.problem).toBe(
      "still-valid: the vendor is down",
    );
    expect((await sandbox.runCli(["status"])).output).toContain(
      "still-valid: the vendor is down (the run carries on)",
    );
  }, 90_000);
});

// Reviews each open pull request by working on it a long while, in flight: a
// run that parked would end at its park (ADR 0021).
const PARKED_REVIEW = `import { defineFlow, GitHub, reportAs, Review, sleep } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const pulls = yield* (yield* GitHub).openPullRequests;

    return pulls.map((pull) => Review.reviewItem(pull, \`pr-\${pull.number}\`));
  }).pipe(reportAs("trigger")),
  stillValid: Review.stillValid,
  workflow: () =>
    Effect.gen(function* () {
      yield* sleep("reviewing", "1 day");

      return "woke";
    }),
});
`;

describe("a notification about a run's work item (#149)", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const status = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse((await sandbox.runCli(["status", "--json"])).output),
    );

  beforeAll(async () => {
    // An hour between interval checks, so only the notification can end the run in time.
    sandbox = openSandbox(
      { limits: { validityEvery: "1 hour", eventTickMin: "1 second" } },
      {
        flows: { "parked-review": { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/parked-review.ts": PARKED_REVIEW },
        events: { local: false, notifications: true },
      },
    );
    await sandbox.runCli(["trust", "demo"]);
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon's socket");
  }, 60_000);

  afterAll(async () => {
    daemon.kill("SIGTERM");
    await sandbox.github.stop();
  });

  test("a parked review run whose pull request is merged by hand ends as superseded within seconds", async () => {
    const pull = sandbox.github.addPull("Reviewed by hand", "feature", "carol", [BOT]);
    let runId = "";

    await eventually(async () => {
      runId = (await status()).active.find((run) => run.itemKey === `pr-${pull}`)?.id ?? "";

      return runId !== "";
    }, `the review of #${pull} to start`);

    sandbox.github.closePull(pull);
    sandbox.github.notify(BOT, "review_requested", pull);

    await eventually(
      async () =>
        (await status()).recent.some((run) => run.id === runId && run.status !== "running"),
      `run ${runId} to end`,
      20_000,
    );

    const ended = (await status()).recent.find((run) => run.id === runId);

    expect(ended?.status).toBe("superseded");
    expect(Option.getOrElse(ended?.summary ?? Option.none(), () => "")).toMatch(
      new RegExp(`^#${pull} was merged`),
    );
  }, 90_000);
});
