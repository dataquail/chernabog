// Claims as leases, end to end with the daemon (#134): a run takes over an
// issue whose claim another machine let expire, and says so; a run that parks
// ends at its park (ADR 0021), letting go of its claim ref so any machine may
// take the item up, and keeping its labels; and a run in flight whose claim
// another machine took over ends as lost, before it writes anything, leaving
// what it held to the taker.

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Claims an issue labelled lease:park, prepares its worktree, and works on it
// a long while, in flight; then it comments, as a run going on with its work
// would.
const PARKED = `import { defineFlow, GitHub, Implement, Issue, reportAs, sleep } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("lease:park");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  stillValid: Implement.stillValid,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      yield* Implement.prepareWorktree(branch);
      yield* sleep("working", "1 day");
      yield* Issue.comment(issue, "went on with the work");

      return "woke";
    }),
});
`;

// Claims an issue labelled lease:wait, then waits on a signal no trigger
// reports, as a run waiting on a person does: on a daemon, as in a CI job, it
// ends at that park.
const PARKING = `import { awaitSignal, defineFlow, GitHub, Implement, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("lease:wait");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      yield* Implement.claim(issue);
      yield* awaitSignal(["never"], { id: "park", timeout: "1 day" });

      return "woke";
    }),
});
`;

// Claims an issue labelled contested, as another flow after the same issue would.
const TAKER = `import { defineFlow, GitHub, Implement, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("contested");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      yield* Implement.claim(yield* Implement.issueOf(item));

      return "took it";
    }),
});
`;

const claimRef = (issue: number) => `refs/chernabog/claims/issue-${issue}`;

// Polls `check` until it holds.
const eventually = async (check: () => Promise<boolean>, what: string, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await Bun.sleep(250);
  }
};

// A claim commit's trailer, such as Expires-At.
const trailer = (message: string, name: string) =>
  Option.fromUndefinedOr(
    message
      .split("\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2),
  );

describe("leases", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const status = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse((await sandbox.runCli(["status", "--json"])).output),
    );

  // The claim on an issue as its ref has it now.
  const claimOn = (issue: number) =>
    Option.map(sandbox.github.refSha(claimRef(issue)), (sha) => ({
      sha,
      message: sandbox.github.messageOf(sha),
    }));

  // The run in flight for an issue, once its claim names it and it has
  // marked the issue claimed, as a person sees.
  const parkedOn = async (issue: number) => {
    let found = Option.none<string>();

    await eventually(async () => {
      found = Option.filter(
        Option.fromUndefinedOr(
          (await status()).active.find((run) => run.itemKey === `issue-${issue}`)?.id,
        ),
        (runId) =>
          sandbox.github.issue(issue).labels.includes("auto:in-progress") &&
          Option.exists(claimOn(issue), (claim) =>
            Option.contains(trailer(claim.message, "Run"), runId),
          ),
      );

      return Option.isSome(found);
    }, `the run for #${issue} to claim it`);

    return Option.getOrThrow(found);
  };

  const ended = async (runId: string) => {
    await eventually(
      async () =>
        (await status()).recent.some((run) => run.id === runId && run.status !== "running"),
      `run ${runId} to end`,
    );

    return Option.getOrThrow(
      Option.fromUndefinedOr((await status()).recent.find((run) => run.id === runId)),
    );
  };

  // Another machine's claim on an issue, whose lease runs to `expiresAt`, on top of `parent`.
  const claimElsewhere = (
    issue: number,
    runId: string,
    expiresAt: string,
    parents: ReadonlyArray<string> = [],
  ) => {
    const sha = sandbox.github.commit(
      [
        "chernabog claim",
        "",
        `Run: ${runId}`,
        "Persona: alice",
        "Flow: parked",
        "Claimed-At: 2026-10-26T02:00:00.000Z",
        `Expires-At: ${expiresAt}`,
      ].join("\n"),
      parents,
    );

    sandbox.github.setRef(claimRef(issue), sha);
  };

  // Another machine taking over the claim on an issue as a run would: by a
  // commit on top of the claim as it stands, through the lease ref on it that
  // only one writer can create, so the daemon renewing it meanwhile loses.
  const takeOverElsewhere = async (issue: number, runId: string, expiresAt: string) => {
    for (;;) {
      const held = Option.getOrThrow(claimOn(issue));
      const lease = `refs/chernabog/leases/issue-${issue}/${held.sha}`;

      if (sandbox.github.createRef(lease, held.sha)) {
        claimElsewhere(issue, runId, expiresAt, [held.sha]);
        sandbox.github.deleteRef(lease);

        return;
      }

      // The daemon is renewing it: take over the claim its renewal leaves.
      await Bun.sleep(50);
    }
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      {
        limits: {
          validityEvery: "1 second",
          leaseTtl: "2 seconds",
          leaseRenewEvery: "1 second",
        },
      },
      {
        flows: {
          parked: { schedule: "*/2 * * * * *", concurrency: 4 },
          parking: { schedule: "*/2 * * * * *" },
          taker: { schedule: "*/2 * * * * *" },
        },
        recipes: [],
        // Runs in flight hold a slot each, as a parked run never did.
        concurrency: 4,
        repoFiles: {
          "flows/parked.ts": PARKED,
          "flows/parking.ts": PARKING,
          "flows/taker.ts": TAKER,
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

  test("a run takes over an issue whose lease another machine let expire, and says so", async () => {
    const issue = sandbox.github.addIssue("Stalled elsewhere", []);
    claimElsewhere(issue, "elsewhere-run", "2026-10-26T14:00:00.000Z");
    sandbox.github.issue(issue).labels.push("lease:park");

    const runId = await parkedOn(issue);
    const claim = Option.getOrThrow(claimOn(issue));

    expect(trailer(claim.message, "Run")).toEqual(Option.some(runId));
    expect(trailer(claim.message, "Taken-Over-From")).toEqual(Option.some("elsewhere-run"));
    // The run says so once it has claimed the issue.
    await eventually(
      async () =>
        sandbox.github
          .commentsOn(issue)
          .some((comment) =>
            comment.body.startsWith(
              "Taken over from alice's run elsewhere-run after its lease expired at 2026-10-26T14:00:00.000Z.",
            ),
          ),
      "the takeover comment",
    );
  }, 90_000);

  test("a run that parks ends at its park, letting go of its claim ref and keeping its labels", async () => {
    const issue = sandbox.github.addIssue("Waiting on a person", ["lease:wait"]);
    let runId = "";

    await eventually(async () => {
      runId = (await status()).recent.find((run) => run.itemKey === `issue-${issue}`)?.id ?? "";

      return runId !== "";
    }, `the run for #${issue} to end`);

    const parked = await ended(runId);

    expect(parked.status).toBe("ended-at-park");
    expect(Option.getOrElse(parked.summary, () => "")).toContain(
      "its record carries the wait, and a later run takes it up",
    );
    // Any machine, or CI, may take the item up now. The run is recorded as
    // ended before its claim ref is deleted, so wait for the ref to go.
    await eventually(async () => Option.isNone(claimOn(issue)), `the claim ref on #${issue} to go`);
    // What it put on the issue stays for the run that takes it up.
    expect(sandbox.github.issue(issue).labels).toContain("auto:in-progress");
  }, 90_000);

  test("a run in flight whose claim another machine took over ends as lost, writing nothing", async () => {
    const issue = sandbox.github.addIssue("Lost while asleep", ["lease:park"]);
    const runId = await parkedOn(issue);

    // Its machine slept past its lease, and another machine took the issue over.
    await takeOverElsewhere(issue, "thief-run", "2999-01-01T00:00:00.000Z");

    const lost = await ended(runId);

    expect(lost.status).toBe("lost");
    expect(Option.getOrElse(lost.summary, () => "")).toContain(
      `alice's run thief-run of parked took issue-${issue} over`,
    );
    expect(
      sandbox.github.commentsOn(issue).some((comment) => comment.body === "went on with the work"),
    ).toBe(false);
    // What it put on the issue is the taker's now: its label and its claim stay.
    expect(sandbox.github.issue(issue).labels).toContain("auto:in-progress");
    expect(trailer(Option.getOrThrow(claimOn(issue)).message, "Run")).toEqual(
      Option.some("thief-run"),
    );
    expect((await sandbox.runCli(["logs", runId])).output).toContain("lost: alice's run thief-run");
  }, 90_000);
});
