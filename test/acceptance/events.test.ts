// Ticks on events (#138): a change a run here makes ticks the repo's flows,
// and a persona's GitHub notifications tick its own, each long before their
// cron schedules would. Both go through the same tick as cron, gates included.

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const often = { schedule: "*/2 * * * * *" };

// Once a year, so only an event ticks it in a test.
const yearly = { schedule: "0 0 0 1 1 *" };

// What made the last tick of a persona's flow, as status says.
const lastCause = async (sandbox: Sandbox, flow: string, persona: string) => {
  const status = Schema.decodeUnknownSync(DaemonStatus)(
    JSON.parse((await sandbox.runCli(["status", "--json"])).output),
  );

  return Option.flatMap(
    Arr.findFirst(
      status.repos.flatMap((repo) => repo.flows),
      (found) => found.name === flow && found.persona === persona,
    ),
    (found) => Option.fromUndefinedOr(found.lastCause),
  );
};

const firstPull = (sandbox: Sandbox) => {
  const first = sandbox.github.firstPull();

  if (Option.isNone(first)) {
    throw new Error("no pull request yet");
  }

  return first.value;
};

describe("a change a run here makes", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(async () => {
    sandbox = openSandbox(
      {
        reviewers: ["bob"],
        flows: { review: { agent: "codex" } },
        limits: { eventTickMin: "1 second" },
      },
      {
        github: ["alice", "bob"],
        personas: ["alice", "bob"],
        personaFlows: { alice: { implement: often }, bob: { review: yearly } },
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

  test("ticks another persona's flow here: bob reviews alice's pull request without waiting for his schedule", async () => {
    sandbox.github.addIssue("Reviewed soon", ["auto:eligible"]);
    await waitFor(
      () =>
        Option.exists(sandbox.github.firstPull(), (pull) =>
          sandbox.github.reviewsOf(pull.number).some((review) => review.author === "bob"),
        ),
      "bob's review",
      60_000,
    );

    expect(firstPull(sandbox).author).toBe("alice");
    expect(sandbox.daemonLog()).toMatch(/started [\da-f-]{36} \(demo\/review pr-\d+ as bob\)/);
    expect(Option.getOrElse(await lastCause(sandbox, "review", "bob"), () => "")).toMatch(
      /^local: /,
    );
  }, 90_000);
});

describe("a persona's GitHub notifications", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(async () => {
    // Bob reviews from another machine; only GitHub's notifications tell alice's.
    sandbox = openSandbox(
      { reviewers: ["bob"] },
      {
        github: ["alice"],
        personas: ["alice"],
        personaFlows: { alice: { implement: often, "address-review": yearly } },
        personaEvents: { alice: { local: false, notifications: true } },
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

  test("a review submitted on alice's pull request starts her address-review within a poll, and never marks it read", async () => {
    sandbox.github.addIssue("Changes asked", ["auto:eligible"]);
    await waitFor(
      () => Option.exists(sandbox.github.firstPull(), (pull) => pull.reviewers.includes("bob")),
      "alice's pull request to ask bob",
      60_000,
    );

    const number = firstPull(sandbox).number;
    sandbox.github.submitReview(number, "bob", "CHANGES_REQUESTED", "Mention the change.");

    await waitFor(
      () =>
        /started [\da-f-]{36} \(demo\/address-review pr-\d+-changes-1 as alice\)/.test(
          sandbox.daemonLog(),
        ),
      "alice's address-review",
      30_000,
    );

    expect(Option.getOrElse(await lastCause(sandbox, "address-review", "alice"), () => "")).toBe(
      `notification: author on #${number}`,
    );
    expect(sandbox.github.requestsBy).toContain("alice GET /notifications");
    // Marking one read is a PATCH or PUT, which the daemon never sends.
    expect(
      sandbox.github.requestsBy.filter((request) => /(PATCH|PUT) \/notifications/.test(request)),
    ).toEqual([]);
  }, 90_000);
});
