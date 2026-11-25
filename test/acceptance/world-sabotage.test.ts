// The world is input, never record (ADR 21, epic #557), through the real CLI
// against the fake GitHub, in CI jobs as alice. implement, the recipe and the
// flow its document compiles to, opens a pull request and ends the job on its
// pending CI; once CI is green a later job hands it off. Between the two, a
// person deletes, or edits, every status label and every comment chernabog
// wrote; or does so while the first job is in the middle of its phase, as
// it opens the pull request. Each journey starts the same jobs, records the
// same phases and ends as an untouched one does, and the labels it leaves are
// the projection's. test/world-sabotage.test.ts runs every recipe's parks so
// on the engine's fakes.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Json, StatusLabels } from "@chernabog/sdk";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { documentOf, generated, IMPLEMENT_DOCUMENT } from "../compose-harness.ts";
import { BOT } from "./fake-github.ts";
import { openSandbox, runnerUserEnv, type Sandbox } from "./sandbox.ts";

const Matrix = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ flow: Schema.String, persona: Schema.String, item: Schema.String })),
);

type Entry = (typeof Matrix.Type)[number];

const STATUS = StatusLabels.statusOf(StatusLabels.DEFAULT_NAMES);

type Sabotage = "delete" | "edit";

type When = "at the park" | "mid-phase";

// What chernabog wrote: alice's comments, and the bot's, as the fake writes
// a comment with no persona's token.
const OURS = ["alice", BOT];

const MARKER = /<!-- (chernabog-[\w-]+) \{.*?\} -->/g;

// A person deletes or edits every status label and every comment chernabog
// wrote on the issue and its pull requests; how many they changed.
const sabotage = (sandbox: Sandbox, how: Sabotage) => {
  let changed = 0;

  const relabel = (labels: Array<string>) => {
    const kept = labels.filter((label) => !STATUS.includes(label));
    const added = STATUS.filter((label) => how === "edit" && !labels.includes(label));
    changed += labels.length - kept.length + added.length;
    labels.splice(0, labels.length, ...kept, ...added);
  };

  for (const issue of sandbox.github.issues.values()) {
    relabel(issue.labels);
  }

  for (const pull of sandbox.github.pulls.values()) {
    relabel(pull.labels);
  }

  for (const [number, comments] of sandbox.github.comments) {
    const kept = comments.flatMap((comment) => {
      if (!OURS.includes(comment.user.login)) {
        return [comment];
      }

      changed += 1;

      return [
        {
          ...comment,
          body: `A person rewrote this.\n\n${comment.body.replaceAll(MARKER, '<!-- $1 {"edited":true} -->')}`,
        },
      ].filter(() => how === "edit");
    });

    sandbox.github.comments.set(number, kept);
  }

  return changed;
};

// Every journey's sandbox, whose servers stop once the file's tests end.
const opened: Array<Sandbox> = [];

afterAll(async () => {
  for (const sandbox of opened) {
    await sandbox.github.stop();
  }
});

const FORMS = [
  ["the recipe", {}],
  [
    "the document",
    {
      "documents/implement.yaml": IMPLEMENT_DOCUMENT,
      "flows/implement.ts": generated(documentOf(IMPLEMENT_DOCUMENT)),
    },
  ],
] as const;

// One journey of an eligible issue through implement in CI jobs, in a
// sandbox of its own, sabotaged as `sabotaged` says; what it did.
const journey = async (
  repoFiles: Readonly<Record<string, string>>,
  sabotaged: Option.Option<{ readonly how: Sabotage; readonly when: When }>,
) => {
  const sandbox = openSandbox(
    { reviewers: ["bob"], ci: { flows: ["implement"] } },
    {
      github: ["alice", "bob"],
      personas: ["alice", "bob"],
      personaFlows: { alice: { implement: {} }, bob: {} },
      repoFiles,
    },
  );

  let jobs = 0;

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
    ...runnerUserEnv(job.user),
    GITHUB_ACTIONS: "true",
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

  const plan = async (name: string, eventName: string, event: Json) => {
    const job = runner(name, event);
    await sandbox.runCli(["ci", "plan"], runnerEnv(job, eventName, sandbox.checkout));

    return Schema.decodeSync(Matrix)(
      Option.getOrThrow(
        Option.fromNullishOr(/^items=(.*)$/m.exec(readFileSync(job.output, "utf8"))?.[1]),
      ),
    );
  };

  const run = async (entry: Entry) => {
    const job = runner(`run-${entry.flow}`, {});
    const checkout = join(job.job, "checkout");
    execFileSync("git", ["clone", "-q", sandbox.bare, checkout]);
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

  const only = (matrix: ReadonlyArray<Entry>) => {
    expect(matrix).toHaveLength(1);

    return matrix[0] ?? { flow: "", persona: "", item: "" };
  };

  // The sandbox's servers stop however the journey ends.
  opened.push(sandbox);

  await sandbox.installCheckout();
  await sandbox.runCli(["trust", "demo"]);
  sandbox.github.setChecks("pending");
  const issue = sandbox.github.addIssue("Waits on CI", ["auto:eligible"]);
  let changed = 0;

  for (const done of Option.toArray(Option.filter(sabotaged, (one) => one.when === "mid-phase"))) {
    sandbox.github.onCreatePull(() => {
      changed += sabotage(sandbox, done.how);

      return "check";
    });
  }

  const labelled = await plan("labelled", "issues", {
    action: "labeled",
    label: { name: "auto:eligible" },
    issue: { number: issue },
    sender: { login: "bob" },
  });

  const first = await run(only(labelled));
  expect(first.code).toBe(0);
  expect(first.output).toContain("parked");

  for (const done of Option.toArray(
    Option.filter(sabotaged, (one) => one.when === "at the park"),
  )) {
    changed += sabotage(sandbox, done.how);
  }

  // A sabotage that found nothing chernabog wrote would prove nothing.
  expect(changed > 0).toBe(Option.isSome(sabotaged));

  sandbox.github.setChecks("green");

  const green = await plan("green", "workflow_run", {
    action: "completed",
    workflow_run: { name: "CI", head_branch: `auto/issue-${issue}`, conclusion: "success" },
  });

  const second = await run(only(green));
  const pull = Option.getOrThrow(sandbox.github.firstPull());

  const seen = {
    planned: [labelled, green],
    first: first.code,
    second: [second.code, second.output.includes("is ready for review")],
    agentRuns: sandbox.claudeCalls().length,
    // Every phase recorded, in order, as each record's announcement says.
    phases: sandbox.github.dispatches.map((sent) => [sent.item, sent.from, sent.to]),
    reviewers: sandbox.github.pull(pull.number).reviewers,
    labels: {
      issue: sandbox.github.issue(issue).labels.filter((label) => STATUS.includes(label)),
      pull: sandbox.github.pull(pull.number).labels.filter((label) => STATUS.includes(label)),
    },
  };

  // A journey that got this far stops its servers now; afterAll stops the rest.
  opened.splice(opened.indexOf(sandbox), 1);
  await sandbox.github.stop();

  return seen;
};

for (const [form, repoFiles] of FORMS) {
  describe(`implement's ${form} in CI jobs, with what chernabog wrote sabotaged`, () => {
    let untouched: Awaited<ReturnType<typeof journey>>;

    beforeAll(async () => {
      untouched = await journey(repoFiles, Option.none());
    }, 240_000);

    test("an untouched journey hands the pull request off once CI is green", () => {
      expect(untouched.second).toEqual([0, true]);
      expect(untouched.reviewers).toEqual(["bob"]);
      expect(untouched.agentRuns).toBe(1);
    });

    for (const [how, when] of [
      ["delete", "at the park"],
      ["edit", "at the park"],
      ["delete", "mid-phase"],
      ["edit", "mid-phase"],
    ] as const) {
      test(`a person who ${how}s every label and comment chernabog wrote, ${when}, changes nothing`, async () => {
        expect(await journey(repoFiles, Option.some({ how, when }))).toEqual(untouched);
      }, 240_000);
    }
  });
}
