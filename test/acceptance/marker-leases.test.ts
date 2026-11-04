// A flow's own marker with a renewal (#354), end to end with the daemon: a run
// that holds a queue's lease has it renewed for the daemon's TTL, status names
// it, keeping what the last renewal said through the checks between renewals,
// and a renewal that reports lost ends the run as lost.

import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Takes a job from a queue, its work item, and waits while it holds the queue's
// lease. The issue's labels stand in for the queue: queue:revoked means the
// queue gave the job away. Each renewal leaves a comment saying for how long.
const QUEUED = `import { activity, awaitSignal, defineFlow, GitHub, Implement, Markers, reportAs } from "@chernabog/sdk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const jobLease = Markers.define(
  "queue-lease",
  Schema.Struct({ job: Schema.Finite }),
  () => Effect.void,
  {
    on: (args) => "job-" + args.job,
    renew: (args, ttl) =>
      Effect.gen(function* () {
        const github = yield* GitHub;
        const job = yield* github.issue(args.job);

        if (job.labels.includes("queue:revoked")) {
          return { status: "lost", reason: "the queue gave job-" + args.job + " to another worker" } as const;
        }

        yield* github.comment(args.job, "renewed for " + Duration.toMillis(ttl));

        return {
          status: "held",
          expiresAt: new Date(Date.now() + Duration.toMillis(ttl)).toISOString(),
        } as const;
      }),
  },
);

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("queue:job");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  markers: [jobLease],
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      yield* activity("lease-job", Markers.hold(jobLease, { job: issue }));
      yield* awaitSignal(["go"], { id: "park", timeout: "1 day" });

      return "woke";
    }),
});
`;

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

describe("a marker that is a lease", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const status = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse((await sandbox.runCli(["status", "--json"])).output),
    );

  beforeAll(async () => {
    sandbox = openSandbox(
      // Checks far more often than renewals, so status has checks to read between them.
      {
        limits: { validityEvery: "1 second", leaseTtl: "2 seconds", leaseRenewEvery: "6 seconds" },
      },
      {
        flows: { queued: { schedule: "*/2 * * * * *" } },
        recipes: [],
        repoFiles: { "flows/queued.ts": QUEUED },
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

  test("is renewed for the daemon's TTL, and a run whose renewal says lost ends as lost", async () => {
    const issue = sandbox.github.addIssue("A job from the queue", ["queue:job"]);

    // Parked, so renewed for parkedLeaseTtl, its default of three days.
    await waitFor(
      () =>
        sandbox.github
          .commentsOn(issue)
          .some((comment) => comment.body === "renewed for 259200000"),
      "the daemon to renew the queue's lease",
    );

    const runId = (await status()).active.find((run) => run.itemKey === `issue-${issue}`)?.id ?? "";

    await eventually(
      async () => (await sandbox.runCli(["status"])).output.includes(`lease on job-${issue} until`),
      "status to name the queue's lease",
    );

    // This marker has no check, so the checks between renewals can't read when
    // its lease runs out: status keeps what the last renewal said.
    for (let looks = 0; looks < 8; looks += 1) {
      expect((await sandbox.runCli(["status"])).output).toContain(`lease on job-${issue} until`);
      await Bun.sleep(400);
    }

    sandbox.github.issue(issue).labels = ["queue:revoked"];

    await eventually(
      async () =>
        (await status()).recent.some((run) => run.id === runId && run.status !== "running"),
      "the run to end",
    );

    const lost = Option.getOrThrow(
      Option.fromUndefinedOr((await status()).recent.find((run) => run.id === runId)),
    );

    expect(lost.status).toBe("lost");
    expect(Option.getOrElse(lost.summary, () => "")).toContain(
      `the queue gave job-${issue} to another worker`,
    );
  }, 90_000);
});
