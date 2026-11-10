// The workflow a repo runs its CI flows in (#461), through the real CLI: init
// and `ci workflow` write it from the flows config.yaml names under ci.flows
// and what they declare; doctor checks it still matches and that the secrets
// it reads exist; and its plan job starts on a runner whose home has no
// machine config, as the workflow gives it none.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";

import { openSandbox, type Sandbox } from "./sandbox.ts";

const WORKFLOW = ".github/workflows/chernabog.yml";

const CI = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: true
`;

// What the tests read of the workflow, and of a runner's machine config.
const Filter = Schema.Struct({
  types: Schema.optionalKey(Schema.Array(Schema.String)),
  workflows: Schema.optionalKey(Schema.Array(Schema.String)),
});

const Workflow = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  permissions: Schema.Unknown,
  jobs: Schema.Struct({
    run: Schema.Struct({
      if: Schema.String,
      concurrency: Schema.Struct({ group: Schema.String }),
    }),
  }),
});

const MachineConfig = Schema.Struct({
  repos: Schema.Array(Schema.Struct({ flows: Schema.Unknown })),
});

const PullRequestOn = Schema.Struct({ on: Schema.Struct({ pull_request: Filter }) });

describe("the CI workflow", () => {
  let sandbox: Sandbox;
  const workflowFile = () => join(sandbox.checkout, WORKFLOW);

  const workflow = () =>
    Schema.decodeUnknownSync(Workflow)(YAML.parse(readFileSync(workflowFile(), "utf8")));

  const pullRequestTypes = () =>
    Schema.decodeUnknownSync(PullRequestOn)(YAML.parse(readFileSync(workflowFile(), "utf8"))).on
      .pull_request.types;

  beforeAll(async () => {
    sandbox = openSandbox({ ci: { flows: ["implement", "review"], maxParallel: 2 } });
    mkdirSync(join(sandbox.checkout, ".github", "workflows"), { recursive: true });
    writeFileSync(join(sandbox.checkout, ".github", "workflows", "ci.yml"), CI);
    await sandbox.installCheckout();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("ci workflow --write writes it, waking on what the CI flows declare, the sweep and a person", async () => {
    const written = await sandbox.runCli(["ci", "workflow", "--write"]);

    expect(written.output).toContain(`wrote ${WORKFLOW}`);
    expect(written.code).toBe(0);

    const { jobs, on, permissions } = workflow();

    expect(on.issues).toEqual({ types: ["labeled"] });
    expect(on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
    expect(pullRequestTypes()).toContain("review_requested");
    expect(on.schedule).toEqual([{ cron: "17 */3 * * *" }]);
    expect(on.workflow_dispatch).toEqual({});
    expect(Object.keys(on)).not.toContain("pull_request_target");
    expect(permissions).toEqual({ contents: "read" });
    expect(readFileSync(workflowFile(), "utf8")).toContain(
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    );
    // Every step's env written out, no YAML alias standing in for one.
    expect(readFileSync(workflowFile(), "utf8")).not.toMatch(/: \*\w+$/m);
    expect(jobs.run.if).toBe("needs.plan.outputs.items != '[]'");
    expect(jobs.run.concurrency.group).toBe("chernabog-${{ matrix.flow }}-${{ matrix.item }}");
  }, 60_000);

  test("written again unchanged, it says so; printed, it is the same text", async () => {
    const again = await sandbox.runCli(["ci", "workflow", "--write"]);
    expect(again.output).toContain(`${WORKFLOW} is up to date`);

    const printed = await sandbox.runCli(["ci", "workflow"]);
    expect(printed.output).toContain(readFileSync(workflowFile(), "utf8"));
  }, 60_000);

  test("init writes it too, and leaves an up-to-date one be", async () => {
    const init = await sandbox.runCli(["init"]);
    expect(init.output).toContain(`${WORKFLOW} is up to date`);
  }, 60_000);

  test("doctor checks that it matches its config, and that the secrets it reads exist", async () => {
    const before = (await sandbox.runCli(["doctor"])).output;
    expect(before).toContain(`✓ demo: ${WORKFLOW} matches its config`);
    expect(before).toContain(
      "✗ demo: the Actions secret CHERNABOG_TOKEN exists, which its CI workflow reads",
    );

    sandbox.github.actionsSecrets.add("CHERNABOG_TOKEN");
    sandbox.github.actionsSecrets.add("CLAUDE_CODE_OAUTH_TOKEN");
    writeFileSync(workflowFile(), readFileSync(workflowFile(), "utf8").replace("17 */3", "5 */3"));

    const after = (await sandbox.runCli(["doctor"])).output;
    expect(after).toContain(
      "✓ demo: the Actions secret CLAUDE_CODE_OAUTH_TOKEN exists, which its CI workflow reads",
    );
    expect(after).toContain(`✗ demo: ${WORKFLOW} matches its config`);
  }, 60_000);

  test("its plan job starts on a runner with a home of its own, enrolling the checkout for the CI flows", async () => {
    const home = join(sandbox.root, "runner-home");
    const output = join(sandbox.root, "github-output");
    writeFileSync(output, "");

    const plan = await sandbox.runCli(["ci", "plan"], {
      CHERNABOG_HOME: home,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "dataquail/demo",
      GITHUB_WORKSPACE: sandbox.checkout,
      GITHUB_OUTPUT: output,
      CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
    });

    expect(plan.code).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("items=[]");
    expect(existsSync(join(home, "config.yaml"))).toBe(true);

    const machine = Schema.decodeUnknownSync(MachineConfig)(
      YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")),
    );

    expect(machine.repos[0]?.flows).toEqual({
      implement: {},
      review: {},
    });
  }, 60_000);
});
