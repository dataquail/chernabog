import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { CiWorkflow } from "./ci-workflow.domain-service.ts";

const on = {
  issues: { types: ["labeled"] },
  pull_request: { types: ["closed", "ready_for_review", "review_requested"] },
  repository_dispatch: { types: ["chernabog-phase"] },
  workflow_run: { workflows: ["CI"], types: ["completed"] },
};

const built = (more: Partial<Parameters<typeof CiWorkflow.build>[0]> = {}) =>
  Result.getOrThrow(CiWorkflow.build({ on, schedule: "17 */3 * * *", version: "0.16.0", ...more }));

describe("the workflow chernabog writes", () => {
  test("wakes on the flows' events, with their types, then on the schedule's sweep and by hand", () => {
    expect(built().document.on).toEqual({
      ...on,
      schedule: [{ cron: "17 */3 * * *" }],
      workflow_dispatch: {},
    });
  });

  test("gives the workflow's token no more than reading the checkout", () => {
    expect(built().document.permissions).toEqual({ contents: "read" });
  });

  test("plans, then runs each entry of the plan in a job of its own, only when there is one", () => {
    const { jobs } = built().document;

    expect(jobs.plan.outputs).toEqual({
      items: "${{ steps.plan.outputs.items }}",
      "max-parallel": "${{ steps.plan.outputs.max-parallel }}",
    });
    expect(jobs.run.needs).toBe("plan");
    expect(jobs.run.if).toBe("needs.plan.outputs.items != '[]'");
    expect(jobs.run.strategy).toEqual({
      "fail-fast": false,
      "max-parallel": "${{ fromJSON(needs.plan.outputs.max-parallel) }}",
      matrix: { include: "${{ fromJSON(needs.plan.outputs.items) }}" },
    });
  });

  test("lets one job at a time work on an item, without cancelling the one at work", () => {
    expect(built().document.jobs.run.concurrency).toEqual({
      group: "chernabog-${{ matrix.flow }}-${{ matrix.item }}",
      "cancel-in-progress": false,
    });
  });

  test("runs the action at the version that wrote it, and pins chernabog to that version", () => {
    const steps = [...built().document.jobs.plan.steps, ...built().document.jobs.run.steps];
    const action = steps.filter((step) => step.uses?.startsWith("dataquail/chernabog/") === true);

    expect(action.map((step) => step.uses)).toEqual([
      "dataquail/chernabog/action@v0.16.0",
      "dataquail/chernabog/action@v0.16.0",
    ]);
    expect(action.map((step) => step.with?.version)).toEqual(["0.16.0", "0.16.0"]);
    expect(action.map((step) => step.with?.step)).toEqual(["plan", "run"]);
  });

  // Both steps that run chernabog take both: ci run's agent runs on Claude's
  // token, and ci plan's usage gate reads the subscription's room this week
  // with it (#459), through the oauthTokenEnv its runner's machine config names.
  test("passes the secrets to the steps that run chernabog, and to no other", () => {
    const { jobs } = built().document;

    for (const step of [...jobs.plan.steps, ...jobs.run.steps]) {
      const secrets = Object.values(step.env ?? {}).filter((value) => value.includes("secrets."));

      if (step.uses?.startsWith("dataquail/chernabog/") === true) {
        expect(step.env).toEqual({
          GH_TOKEN: "${{ secrets.CHERNABOG_TOKEN }}",
          CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
        });
      } else {
        expect(secrets).toEqual([]);
      }
    }
  });

  test("checks the default branch out, leaving the workflow's token out of git's config", () => {
    const checkouts = [
      ...built().document.jobs.plan.steps,
      ...built().document.jobs.run.steps,
    ].flatMap((step) =>
      Arr.filter([step.with], () => step.uses?.startsWith("actions/checkout@") === true),
    );

    expect(checkouts.map((options) => options?.["persist-credentials"])).toEqual([false, false]);
    expect(checkouts.map((options) => options?.ref)).toEqual([
      "${{ github.event.repository.default_branch }}",
      "${{ github.event.repository.default_branch }}",
    ]);
  });

  test("pins the actions it runs from elsewhere by commit, as this repo's own workflows do", () => {
    const { jobs } = built().document;

    const uses = [...jobs.plan.steps, ...jobs.run.steps].flatMap((step) =>
      Arr.filter([step.uses ?? ""], (named) => !named.startsWith("dataquail/chernabog/")),
    );

    expect(uses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    ]);
  });

  test("says each pinned action's version beside its commit", () => {
    expect(
      CiWorkflow.withVersionComments(
        [
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
          "        uses: dataquail/chernabog/action@v0.16.0",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
        "        uses: dataquail/chernabog/action@v0.16.0",
        "",
      ].join("\n"),
    );
  });

  test("uploads the run log and the transcripts whatever became of the run", () => {
    const upload = built().document.jobs.run.steps.find(
      (step) => step.uses?.startsWith("actions/upload-artifact@") === true,
    );

    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path).toBe("${{ runner.temp }}/chernabog-logs");
    expect(upload?.with?.["retention-days"]).toBe(5);
  });

  test("refuses pull_request_target, on which an agent never runs", () => {
    const refused = CiWorkflow.build({
      on: { ...on, pull_request_target: { types: ["opened"] } },
      schedule: "17 */3 * * *",
      version: "0.16.0",
    });

    expect(Result.isFailure(refused)).toBe(true);
    expect(Result.getFailure(refused).pipe(Option.getOrThrow)).toContain("pull_request_target");
  });

  test("says when the sweep is scheduled on the hour, when GitHub drops the most", () => {
    expect(built({ schedule: "0 */3 * * *" }).notes).toEqual([
      'ci.schedule "0 */3 * * *" runs on the hour, when GitHub drops the most scheduled runs; an odd minute, such as 17, is safer',
    ]);
    expect(built().notes).toEqual([]);
  });
});

describe("the repo's CI workflows, which a CI run's completion wakes from", () => {
  test("are those a push or a pull request starts, by name, never chernabog's own", () => {
    expect(
      CiWorkflow.ciWorkflows([
        { file: "ci.yml", name: Option.some("CI"), events: ["pull_request", "push"] },
        { file: "lint.yml", name: Option.none(), events: ["push"] },
        { file: "release.yml", name: Option.some("Release"), events: ["workflow_dispatch"] },
        { file: "chernabog.yml", name: Option.some("chernabog"), events: ["pull_request"] },
      ]),
    ).toEqual(["CI", ".github/workflows/lint.yml"]);
  });
});

describe("the version a workflow file pins", () => {
  test("is the action's tag", () => {
    expect(
      CiWorkflow.pinnedVersion("    uses: dataquail/chernabog/action@v0.16.0\n").pipe(
        Option.getOrThrow,
      ),
    ).toBe("0.16.0");
    expect(Option.isNone(CiWorkflow.pinnedVersion("name: other\n"))).toBe(true);
  });
});
