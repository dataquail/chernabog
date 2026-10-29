// Review requests no persona on this machine serves (#76): doctor warns when
// a persona's pull requests can only go to reviewers it doesn't act as, and
// status lists the pull requests waiting on them under the review flow. Both
// come from the recipes (#208): their doctor checks, and the review trigger's
// items that wait on someone.

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const CreatedPull = Schema.Struct({ number: Schema.Finite });

const often = { schedule: "*/2 * * * * *" };

// Only by `chernabog trigger`.
const never = { schedule: "0 0 1 1 *" };

// Status, once it says what's wanted.
const statusWhen = async (sandbox: Sandbox, wanted: (status: string) => boolean, what: string) => {
  const deadline = Date.now() + 30_000;

  for (;;) {
    const status = (await sandbox.runCli(["status"])).output;

    if (wanted(status)) {
      return status;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await Bun.sleep(500);
  }
};

const UNSERVED =
  "demo as alice: pull requests authored as alice go to bob, which this machine doesn't act as; they wait until another machine reviews them";

// alice opens pull requests; the pool is alice and bob. `reviewer` is bob's
// flows in the repo, when bob is one of its personas.
const doctorWith = (
  github: ReadonlyArray<string>,
  reviewer: Option.Option<Readonly<Record<string, typeof never>>> = Option.none(),
) => {
  let sandbox: Sandbox;

  beforeAll(() => {
    const alice = { implement: never, review: never };

    sandbox = openSandbox(
      { reviewers: ["alice", "bob"] },
      Option.match(reviewer, {
        onNone: () => ({ github, personas: ["alice"], personaFlows: { alice } }),
        onSome: (bob) => ({ github, personas: ["alice", "bob"], personaFlows: { alice, bob } }),
      }),
    );
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  return async () => (await sandbox.runCli(["doctor"])).output;
};

describe("doctor, on a machine that acts only as the author", () => {
  const doctor = doctorWith(["alice"]);

  test("warns that its pull requests go to a login this machine does not act as", async () => {
    const said = await doctor();
    expect(said).toContain(`! ${UNSERVED}`);
    expect(said).toContain(
      "fix: run a flow that reviews, such as review, as one of bob on this machine",
    );
  });
});

describe("doctor, on a machine that acts as the other reviewer but doesn't review as it", () => {
  const doctor = doctorWith(["alice", "bob"]);

  test("warns that no persona here reviews as that login", async () => {
    const said = await doctor();
    expect(said).not.toContain("which this machine doesn't act as");
    expect(said).toContain("go to bob, which no persona here reviews as");
  });
});

describe("doctor, on a machine where the other reviewer runs review", () => {
  const doctor = doctorWith(["alice", "bob"], Option.some({ review: never }));

  test("stays quiet", async () => {
    const said = await doctor();
    expect(said).not.toContain("which this machine doesn't act as");
    expect(said).not.toContain("which no persona here reviews as");
  });
});

describe("status, on review requests no persona here serves", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(async () => {
    sandbox = openSandbox(
      { reviewers: ["alice", "bob"] },
      { github: ["alice"], personas: ["alice"], personaFlows: { alice: { review: often } } },
    );
    await sandbox.runCli(["trust", "demo"]);
  });

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("lists a pull request waiting on another login's review under the review flow, until that review is in", async () => {
    sandbox.git(sandbox.checkout, "checkout", "-qb", "feature");
    sandbox.git(sandbox.checkout, "commit", "-q", "--allow-empty", "-m", "feat: by a person");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "feature");

    const created = await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls`, {
      method: "POST",
      body: JSON.stringify({ head: "feature", base: "main", title: "feat: by a person", body: "" }),
    });

    const { number } = Schema.decodeUnknownSync(CreatedPull)(await created.json());
    sandbox.github.pull(number).reviewers.push("bob");
    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");

    const waiting = `pr-${number} waits on bob (not on this machine)`;

    const status = await statusWhen(
      sandbox,
      (said) => said.includes(waiting),
      "status to list the review waiting on bob",
    );

    expect(status.split("\n").find((line) => line.startsWith("  review as alice:"))).toContain(
      `waiting: ${waiting}`,
    );

    // bob reviews it from another machine; GitHub drops the request.
    await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls/${number}/reviews`, {
      method: "POST",
      headers: { authorization: "Bearer token-bob" },
      body: JSON.stringify({
        body: "Looks right.",
        commit_id: sandbox.git(sandbox.checkout, "rev-parse", "HEAD").trim(),
        event: "APPROVE",
      }),
    });

    await statusWhen(
      sandbox,
      (said) => !said.includes(waiting),
      "status to drop it once bob has reviewed",
    );
  }, 60_000);
});
