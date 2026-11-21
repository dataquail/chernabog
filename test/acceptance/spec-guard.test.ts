// A pull request that changes a behavior spec goes to a person (ADR 22,
// decision 3, #579), through the daemon: erin, the persona that reviews here,
// neither reviews nor merges one on the automated path until a person
// approves the spec, and taking the label off without that doesn't stick.

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const CreatedPull = Schema.Struct({ number: Schema.Finite });

const often = { schedule: "*/2 * * * * *" };

const FEATURE = "test/features/review-loop.feature";
const NEEDS_HUMAN = "auto:needs-human";

describe("a pull request that changes a behavior spec", () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(() => {
    sandbox = openSandbox(
      {
        // The repo's personas, by its committed config: erin alone.
        personas: ["erin"],
        reviewers: ["erin"],
        flows: {
          review: { ...often, agent: "codex" },
          implement: { enabled: false },
          "address-review": { enabled: false },
          "re-review": { enabled: false },
        },
      },
      { github: ["erin"], personas: ["erin"], flows: { review: often } },
    );
  });

  afterAll(async () => {
    daemon.kill("SIGTERM");
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("is never reviewed or merged by a persona until a person approves its spec", async () => {
    await sandbox.runCli(["trust", "demo"]);

    // carol, a person, changes the spec and ships it on the automated path.
    sandbox.git(sandbox.checkout, "checkout", "-qb", "spec-change");
    mkdirSync(join(sandbox.checkout, "test/features"), { recursive: true });
    writeFileSync(
      join(sandbox.checkout, FEATURE),
      "Feature: the review loop\n  Scenario: bob's review run stays parked\n",
    );
    sandbox.git(sandbox.checkout, "add", FEATURE);
    sandbox.git(sandbox.checkout, "commit", "-q", "-m", "test: the review loop's spec");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "spec-change");

    const response = await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls`, {
      method: "POST",
      headers: { authorization: "Bearer token-carol" },
      body: JSON.stringify({
        head: "spec-change",
        base: "main",
        title: "test: the review loop's spec",
        body: "",
      }),
    });

    const { number } = Schema.decodeUnknownSync(CreatedPull)(await response.json());
    const pull = sandbox.github.pull(number);
    pull.labels.push("auto:ship");
    pull.reviewers.push("erin");

    daemon = sandbox.cli(["daemon"]);
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");

    // Handed to a person, saying which spec, and not reviewed.
    await waitFor(() => pull.labels.includes(NEEDS_HUMAN), "the hand-off to a person", 45_000);
    expect(
      sandbox.github.commentsOn(number).some((comment) => comment.body.includes(`\`${FEATURE}\``)),
    ).toBe(true);
    expect(sandbox.github.reviewsOf(number)).toEqual([]);

    // Taking the label off without a person's approval doesn't stick.
    pull.labels = pull.labels.filter((label) => label !== NEEDS_HUMAN);
    await waitFor(() => pull.labels.includes(NEEDS_HUMAN), "the hand-off again", 45_000);
    expect(sandbox.github.reviewsOf(number)).toEqual([]);
    expect(sandbox.github.merges).toEqual([]);
    expect(sandbox.codexCalls()).toEqual([]);

    // zach, a person, approves the spec as it stands, and takes the label off:
    // erin reviews it now.
    sandbox.github.submitReview(number, "zach", "APPROVED", "The spec reads right.");
    pull.labels = pull.labels.filter((label) => label !== NEEDS_HUMAN);
    await waitFor(
      () => sandbox.github.reviewsOf(number).some((review) => review.author === "erin"),
      "erin's review, once a person approved the spec",
      45_000,
    );
    expect(pull.labels).not.toContain(NEEDS_HUMAN);
  }, 180_000);
});
