// The plan job woken by a phase announcement (#465): a `chernabog-phase`
// repository_dispatch, as the daemon sends after each advance (#458), makes the
// plan job start the CI flow due at the item's new phase. The phases are the
// real flows' own: alice's implement asks bob for a review, and bob's review,
// on this machine as on a laptop, asks for changes. The plan job then runs on
// a runner as alice, with address-review in ci.flows.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Claims } from "@chernabog/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox } from "./sandbox.ts";

const Matrix = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ flow: Schema.String, persona: Schema.String, item: Schema.String })),
);

describe("the plan job woken by a phase announcement", () => {
  let sandbox: Sandbox;

  const pullNumber = () =>
    Option.getOrThrow(Option.map(sandbox.github.firstPull(), (pull) => pull.number));

  // The plan job on a runner of its own, as alice's token, for an event, in
  // the workflow run `workflowRun`.
  const planOn = async (
    name: string,
    event: { readonly name: string; readonly payload: unknown },
    workflowRun: string,
  ) => {
    const job = join(sandbox.root, `plan-${name}`);
    mkdirSync(job, { recursive: true });
    const eventPath = join(job, "event.json");
    const output = join(job, "github-output");
    const summary = join(job, "summary.md");
    writeFileSync(eventPath, JSON.stringify(event.payload));
    writeFileSync(output, "");
    writeFileSync(summary, "");

    const plan = await sandbox.runCli(["ci", "plan"], {
      CHERNABOG_HOME: join(job, "home"),
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "dataquail/demo",
      GITHUB_WORKSPACE: sandbox.checkout,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_EVENT_NAME: event.name,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ID: workflowRun,
      GH_TOKEN: "token-alice",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
    });

    const items = Option.getOrThrow(
      Option.fromNullishOr(/^items=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1]),
    );

    return {
      ...plan,
      matrix: Schema.decodeSync(Matrix)(items),
      summary: readFileSync(summary, "utf8"),
    };
  };

  let workflowRuns = 500;

  // The run id the claim on `item` names, if anyone holds it.
  const claimHolder = (item: string) =>
    Option.flatMap(sandbox.github.refSha(`refs/chernabog/claims/${item}`), (sha) =>
      Option.map(
        Claims.holderOf(
          execFileSync("git", ["-C", sandbox.bare, "log", "-1", "--format=%B", sha], {
            encoding: "utf8",
          }),
        ),
        (found) => found.runId,
      ),
    );

  // The plan job for a dispatch of this phase.
  const planFor = (
    name: string,
    payload: { item: string; from: Option.Option<string>; to: string },
  ) => {
    workflowRuns += 1;

    // As the daemon sends it (phasePayload): a first phase comes from null.
    return planOn(
      name,
      {
        name: "repository_dispatch",
        payload: {
          action: "chernabog-phase",
          client_payload: { ...payload, from: Option.getOrNull(payload.from) },
        },
      },
      String(workflowRuns),
    );
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      {
        reviewers: ["bob"],
        flows: { review: { agent: "codex" } },
        // review too, as the rehearsal repo has it: on the runner it runs as
        // alice, who writes the code and has no seat in the reviewer pool.
        ci: { flows: ["implement", "address-review", "review"] },
      },
      {
        github: ["alice", "bob"],
        personas: ["alice", "bob"],
        personaFlows: {
          alice: { implement: {}, "address-review": {} },
          bob: { review: {} },
        },
      },
    );
    await sandbox.installCheckout();
    await sandbox.runCli(["trust", "demo"]);

    sandbox.github.addIssue("Phased work", ["auto:eligible"]);
    const implement = await sandbox.runCli(["run", "implement", "--repo", "demo", "--as", "alice"]);
    expect(implement.code).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("a phase no CI flow of alice's waits on starts nothing, and review is skipped, not failed", async () => {
    const item = `pr-${pullNumber()}`;
    const plan = await planFor("review-asked", { item, from: Option.none(), to: "review-asked" });

    expect(plan.code).toBe(0);
    expect(plan.matrix).toEqual([]);
    expect(plan.summary).toContain(
      `Payload: \`{"item":"${item}","from":null,"to":"review-asked"}\``,
    );
    expect(plan.summary).toContain(
      "review as alice: skipped: not in the reviewer pool (reviewers: bob)",
    );
    expect(plan.summary).not.toContain("trigger failed");
    expect(plan.output).not.toContain("trigger failed");
  }, 60_000);

  test("changes asked for start address-review on the item, as its author", async () => {
    const review = await sandbox.runCli(["run", "review", "--repo", "demo", "--as", "bob"]);

    expect(review.code).toBe(0);

    const item = `pr-${pullNumber()}`;

    const plan = await planFor("changes-asked", {
      item,
      from: Option.some("review-asked"),
      to: "changes-asked",
    });

    expect(plan.code).toBe(0);
    expect(plan.matrix).toHaveLength(1);
    expect(plan.matrix[0]?.flow).toBe("address-review");
    expect(plan.matrix[0]?.persona).toBe("alice");
    expect(plan.matrix[0]?.item).toStartWith(`${item}-changes-asked-`);
    expect(plan.summary).toContain("Starts 1 run job:");

    // The plan reserved the item for the run job it starts.
    expect(sandbox.github.refSha(`refs/chernabog/claims/${item}`)).not.toEqual(Option.none());

    // The review's own event, a second plan for the same step, arrives before
    // the first plan's run job has claimed the item, and starts no second one.
    const evented = await planOn(
      "changes-asked-review-event",
      {
        name: "pull_request_review",
        payload: {
          action: "submitted",
          pull_request: { number: pullNumber(), author_association: "MEMBER" },
          review: { state: "changes_requested", author_association: "MEMBER" },
          sender: { login: "bob" },
        },
      },
      "600",
    );

    expect(evented.code).toBe(0);
    expect(evented.matrix).toEqual([]);
    expect(evented.summary).toContain("Starts no run job.");
    const reservation = `ci-plan-${workflowRuns}-${item}`;
    expect(claimHolder(item)).toEqual(Option.some(reservation));

    // The first plan's run job takes the reservation over and does the step:
    // to its trigger, the reservation is its own, not a run that owns the PR.
    const job = join(sandbox.root, "run-changes-asked");

    const run = await sandbox.runCli(
      [
        "ci",
        "run",
        "--flow",
        "address-review",
        "--persona",
        "alice",
        "--item",
        plan.matrix[0]?.item ?? "",
        "--logs",
        join(job, "logs"),
      ],
      {
        CHERNABOG_HOME: join(job, "home"),
        GITHUB_REPOSITORY: "dataquail/demo",
        GITHUB_WORKSPACE: sandbox.checkout,
        GITHUB_RUN_ID: String(workflowRuns),
        GH_TOKEN: "token-alice",
        CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
      },
    );

    expect(run.output).not.toContain("another run got there first");
    expect(run.output).toContain("started ");
    expect(claimHolder(item)).not.toEqual(Option.some(reservation));

    // The dispatch names the item: one for another pull request starts nothing here.
    const other = await planFor("other-item", {
      item: `pr-${pullNumber() + 100}`,
      from: Option.some("review-asked"),
      to: "changes-asked",
    });

    expect(other.matrix).toEqual([]);
  }, 120_000);
});
