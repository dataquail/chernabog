import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { fixture } from "../../../../../test/fixtures.ts";
import {
  BranchRule,
  CheckRun,
  classifyBranch,
  classifyChecks,
  classifyCommit,
  describe,
  requiredChecksFrom,
  type WorkflowRun,
} from "./ci.ts";

const Rules = Schema.Array(BranchRule);
const CheckRunsPage = Schema.Struct({ check_runs: Schema.Array(CheckRun) });

const recorded = Effect.all({
  goodbonesRequired: fixture("goodbones-branch-rules.json", Rules).pipe(
    Effect.map(requiredChecksFrom),
  ),
  hexagonRequired: fixture("fddh-branch-rules.json", Rules).pipe(Effect.map(requiredChecksFrom)),
  greenRuns: fixture("goodbones-check-runs-green.json", CheckRunsPage).pipe(
    Effect.map((page) => page.check_runs),
  ),
  redRuns: fixture("fddh-check-runs.json", CheckRunsPage).pipe(
    Effect.map((page) => page.check_runs),
  ),
});

const run = (
  name: string,
  status: string,
  conclusion: Option.Option<string>,
  id = 1,
): CheckRun => ({ id, name, status, conclusion });

effect("required checks come from the base branch rules", () =>
  Effect.gen(function* () {
    const { goodbonesRequired, hexagonRequired } = yield* recorded;
    expect(goodbonesRequired).toEqual(["commitlint", "lint", "test", "check"]);
    expect(hexagonRequired).toContain("Integration / Integration (server + jobs)");
  }),
);

effect("every required check passing is green, even with skipped extras", () =>
  Effect.gen(function* () {
    const { goodbonesRequired, greenRuns } = yield* recorded;
    expect(classifyChecks(greenRuns, goodbonesRequired)).toEqual({ state: "green" });
  }),
);

effect("a failing check is red, named", () =>
  Effect.gen(function* () {
    const { hexagonRequired, redRuns } = yield* recorded;
    expect(classifyChecks(redRuns, hexagonRequired)).toEqual({
      state: "red",
      failedChecks: ["Unit tests"],
    });
  }),
);

effect("a required check that has not reported yet keeps it pending", () =>
  Effect.gen(function* () {
    const { goodbonesRequired, greenRuns } = yield* recorded;
    const withoutTest = greenRuns.filter((checkRun) => checkRun.name !== "test");
    expect(classifyChecks(withoutTest, goodbonesRequired)).toEqual({
      state: "pending",
      waitingOn: ["test"],
    });
  }),
);

effect("a required check still running keeps it pending", () =>
  Effect.gen(function* () {
    const { goodbonesRequired, greenRuns } = yield* recorded;

    const lintRunning = greenRuns.map((checkRun) =>
      Option.getOrElse(
        Option.map(
          Option.liftPredicate(checkRun, (found) => found.name === "lint"),
          (found) => run(found.name, "in_progress", Option.none(), found.id),
        ),
        () => checkRun,
      ),
    );

    expect(classifyChecks(lintRunning, goodbonesRequired)).toEqual({
      state: "pending",
      waitingOn: ["lint"],
    });
  }),
);

effect("a failure turns red at once, without waiting for slow checks", () =>
  Effect.gen(function* () {
    const { goodbonesRequired } = yield* recorded;

    const runs = [
      run("commitlint", "completed", Option.some("failure")),
      run("test", "in_progress", Option.none()),
    ];

    expect(classifyChecks(runs, goodbonesRequired)).toEqual({
      state: "red",
      failedChecks: ["commitlint"],
    });
  }),
);

effect("a rerun that passes replaces the failure it reran", () =>
  Effect.gen(function* () {
    const { goodbonesRequired, greenRuns } = yield* recorded;
    const others = greenRuns.filter((checkRun) => checkRun.name !== "test");

    const runs = [
      ...others,
      run("test", "completed", Option.some("success"), 2),
      run("test", "completed", Option.some("failure"), 1),
    ];

    expect(classifyChecks(runs, goodbonesRequired)).toEqual({ state: "green" });
  }),
);

effect("with no required checks, everything that ran must finish and pass", () =>
  Effect.gen(function* () {
    const { greenRuns } = yield* recorded;
    expect(classifyChecks(greenRuns, [])).toEqual({ state: "green" });
    expect(classifyChecks([], [])).toEqual({ state: "pending", waitingOn: [] });
  }),
);

test("the printed result is one word, then what it is about", () => {
  expect(describe({ state: "green" })).toBe("green");
  expect(describe({ state: "red", failedChecks: ["lint", "test"] })).toBe("red lint, test");
  expect(describe({ state: "pending", waitingOn: ["test"] })).toBe("pending test");
});

const workflowRun = (
  id: number,
  name: string,
  status: string,
  conclusion: Option.Option<string>,
): WorkflowRun => ({
  id,
  name,
  workflow_id: name.length,
  event: "push",
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  check_suite_id: id,
});

test("a branch is red by its newest completed run, whatever runs after it", () => {
  const reading = classifyBranch([
    workflowRun(3, "CI", "in_progress", Option.none()),
    workflowRun(2, "CI", "completed", Option.some("failure")),
    workflowRun(1, "CI", "completed", Option.some("success")),
  ]);

  expect(reading).toMatchObject({ state: "red", failedChecks: ["CI"] });
  expect(reading.failedRuns).toEqual([
    {
      name: "CI",
      url: "https://github.com/o/r/actions/runs/2",
      job: Option.none(),
      workflowRun: Option.some(2),
    },
  ]);
});

test("a cancelled run decides nothing about its branch", () => {
  expect(
    classifyBranch([
      workflowRun(2, "CI", "completed", Option.some("cancelled")),
      workflowRun(1, "CI", "completed", Option.some("success")),
    ]),
  ).toEqual({ state: "green", failedRuns: [] });

  expect(classifyBranch([workflowRun(1, "CI", "completed", Option.some("cancelled"))])).toEqual({
    state: "pending",
    waitingOn: ["CI"],
    failedRuns: [],
  });
});

test("a branch with no runs is pending on nothing", () => {
  expect(classifyBranch([])).toEqual({ state: "pending", waitingOn: [], failedRuns: [] });
});

test("a commit links only the latest failed run of each check", () => {
  const link = (url: string) => ({
    name: "test",
    url,
    job: Option.none<number>(),
    workflowRun: Option.none<number>(),
  });

  const reading = classifyCommit([
    { check: run("test", "completed", Option.some("failure"), 2), link: link("second") },
    { check: run("test", "completed", Option.some("failure"), 1), link: link("first") },
  ]);

  expect(reading).toMatchObject({ state: "red", failedChecks: ["test"] });
  expect(reading.failedRuns.map((failed) => failed.url)).toEqual(["second"]);
});
