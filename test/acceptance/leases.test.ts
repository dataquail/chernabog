// Claims as leases, end to end with the daemon (#134): a run takes over an
// issue whose claim another machine let expire, and says so; a parked run's
// lease outlives a short leaseTtl, renewed in time, so a would-be taker skips
// it; and a parked run whose claim another machine took over ends as lost when
// it wakes, before it writes anything, leaving what it held to the taker.

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Claims an issue labelled lease:park, prepares its worktree, and waits on
// `go`, which its trigger reports once the issue is labelled go; then it
// comments, as a run going on with its work would.
const PARKED = `import { awaitSignal, defineFlow, GitHub, Implement, Issue, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("lease:park");

    return issues.map((issue) => ({
      ...Implement.issueItem(issue),
      signals: issue.labels.includes("go") ? ["go"] : [],
    }));
  }).pipe(reportAs("trigger")),
  stillValid: Implement.stillValid,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      yield* Implement.prepareWorktree(branch);
      yield* awaitSignal(["go"], { id: "park", timeout: "1 day" });
      yield* Issue.comment(issue, "went on with the work");

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

  // The run in flight for an issue, once it's parked on its signal.
  const parkedOn = async (issue: number) => {
    let found = Option.none<string>();

    await eventually(async () => {
      found = Option.fromUndefinedOr(
        (await status()).active.find((run) => run.itemKey === `issue-${issue}` && run.parked)?.id,
      );

      return Option.isSome(found);
    }, `the run for #${issue} to park`);

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

  // The claim on an issue as its ref has it now.
  const claimOn = (issue: number) =>
    Option.map(sandbox.github.refSha(claimRef(issue)), (sha) => ({
      sha,
      message: sandbox.github.messageOf(sha),
    }));

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
          parked: { schedule: "*/2 * * * * *" },
          taker: { schedule: "*/2 * * * * *" },
        },
        recipes: [],
        repoFiles: { "flows/parked.ts": PARKED, "flows/taker.ts": TAKER },
      },
    );
    await sandbox.runCli(["trust", "demo"]);
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon's socket");
  });

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
    expect(
      sandbox.github
        .commentsOn(issue)
        .some((comment) =>
          comment.body.startsWith(
            "Taken over from alice's run elsewhere-run after its lease expired at 2026-10-26T14:00:00.000Z.",
          ),
        ),
    ).toBe(true);
  }, 90_000);

  test("a parked run's lease outlives a short leaseTtl, so a would-be taker skips the issue", async () => {
    const issue = sandbox.github.addIssue("Waiting on review", ["lease:park"]);
    const runId = await parkedOn(issue);

    // Well past leaseTtl: the daemon has renewed it, for parkedLeaseTtl.
    await Bun.sleep(5000);
    const claim = Option.getOrThrow(claimOn(issue));
    const expiresAt = Date.parse(Option.getOrThrow(trailer(claim.message, "Expires-At")));

    expect(trailer(claim.message, "Run")).toEqual(Option.some(runId));
    expect(Option.isSome(trailer(claim.message, "Renewed-At"))).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now() + 24 * 3_600_000);
    expect((await status()).active.some((run) => run.id === runId)).toBe(true);
    expect((await sandbox.runCli(["status"])).output).toContain(`lease on issue-${issue} until`);

    sandbox.github.issue(issue).labels.push("contested");

    // The trigger keeps reporting the issue, so later takers may be in flight: look at one that ended.
    const takerEnded = (run: {
      readonly flow: string;
      readonly itemKey: string;
      readonly status: string;
    }) => run.flow === "taker" && run.itemKey === `issue-${issue}` && run.status !== "running";

    await eventually(
      async () => (await status()).recent.some(takerEnded),
      "the taker's run to end",
    );

    const taker = (await status()).recent.find(takerEnded);

    expect(taker?.status).toBe("skipped");
    expect(Option.getOrElse(taker?.summary ?? Option.none(), () => "")).toContain(
      `#${issue} is already claimed (run ${runId} of parked holds ${claimRef(issue)}`,
    );
    expect(trailer(Option.getOrThrow(claimOn(issue)).message, "Run")).toEqual(Option.some(runId));
  }, 90_000);

  test("a run whose claim another machine took over ends as lost when it wakes, writing nothing", async () => {
    const issue = sandbox.github.addIssue("Lost while asleep", ["lease:park"]);
    const runId = await parkedOn(issue);

    // Its machine slept past its lease, and another machine took the issue over.
    await takeOverElsewhere(issue, "thief-run", "2999-01-01T00:00:00.000Z");
    sandbox.github.issue(issue).labels.push("go");

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
