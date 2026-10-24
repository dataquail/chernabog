import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { ScenarioRoot } from "./scenario.root.ts";
import { ScenarioRootOps } from "./scenario.root-ops.ts";

const scenario = (fields: Partial<ConstructorParameters<typeof ScenarioRoot>[0]> = {}) =>
  ScenarioRoot.make({
    path: "/repo/.chernabog/rehearsals/implement.yaml",
    dir: "/repo/.chernabog/rehearsals",
    repo: "you/chernabog-rehearsal",
    ...fields,
  });

const seeded = {
  issues: [{ name: "bug", number: 12 }],
  pullRequests: [{ name: "fix", number: 7, branch: "rehearsal/fix" }],
};

describe("a scenario's target", () => {
  test("a scratch repo is fine; an enrolled one only when the scenario or the person means it", () => {
    expect(ScenarioRootOps.target(scenario(), ["you/app"], false)).toEqual(Result.succeed(false));

    const refused = ScenarioRootOps.target(scenario({ repo: "You/App" }), ["you/app"], false);
    expect(Result.isFailure(refused)).toBe(true);
    expect(Option.map(Result.getFailure(refused), (failure) => failure.repo)).toEqual(
      Option.some("You/App"),
    );

    expect(ScenarioRootOps.target(scenario({ repo: "you/app" }), ["you/app"], true)).toEqual(
      Result.succeed(true),
    );
    expect(
      ScenarioRootOps.target(scenario({ repo: "you/app", enrolled: true }), ["you/app"], false),
    ).toEqual(Result.succeed(true));
  });

  test("the flow named on the command line must be the scenario's", () => {
    expect(ScenarioRootOps.flowOf(scenario(), "implement")).toEqual(Result.succeed("implement"));
    expect(ScenarioRootOps.flowOf(scenario({ flow: "review" }), "review")).toEqual(
      Result.succeed("review"),
    );
    expect(
      Result.isFailure(ScenarioRootOps.flowOf(scenario({ flow: "review" }), "implement")),
    ).toBe(true);
  });
});

describe("stand-ins", () => {
  test("a replayed run's answers stand in, with the scenario's own over them", () => {
    const replay = ScenarioRootOps.replayed([
      { step: "implement", answer: { status: "done" }, commits: ["Fix the bug"] },
      { step: "fix-ci-1", answer: { status: "done" }, commits: [] },
    ]);

    expect(replay.implement).toEqual({ fixture: { status: "done" }, commits: ["Fix the bug"] });

    const own = scenario({ agent: { "fix-ci-*": { script: "./fix.sh" } } });
    expect(ScenarioRootOps.standIns(own, replay)).toEqual({
      ...replay,
      "fix-ci-*": { script: "./fix.sh" },
    });
  });

  test("the stand-ins no step asked for are reported", () => {
    const standIns = { implement: { fixture: {} }, "old-step": { fixture: {} } };
    expect(ScenarioRootOps.unused(standIns, ["implement", "review-1"])).toEqual(["old-step"]);
  });
});

describe("a rehearsal's work", () => {
  test("is only what seeding made", () => {
    expect(ScenarioRootOps.isSeeded(seeded, "issue-12")).toBe(true);
    expect(ScenarioRootOps.isSeeded(seeded, "pr-7")).toBe(true);
    expect(ScenarioRootOps.isSeeded(seeded, "pr-7-changes-2")).toBe(true);
    expect(ScenarioRootOps.isSeeded(seeded, "issue-120")).toBe(false);
    expect(ScenarioRootOps.isSeeded(seeded, "nightly")).toBe(false);
  });

  test("ends where the scenario expected, or says how it didn't", () => {
    const expecting = scenario({
      expect: { ends: "needs-human", summary: "loop cap", labels: ["auto:needs-human"] },
    });

    expect(
      ScenarioRootOps.missed(expecting, {
        ending: "needs-human",
        summary: "#12: loop cap reached",
        labels: ["AUTO:needs-human"],
      }),
    ).toEqual([]);

    expect(
      ScenarioRootOps.missed(expecting, {
        ending: "done",
        summary: "#12 is ready for review",
        labels: ["auto:needs-review"],
      }),
    ).toEqual([
      "ended done, not needs-human",
      `its summary doesn't say "loop cap": #12 is ready for review`,
      "the item carries auto:needs-review, not auto:needs-human",
    ]);

    expect(
      ScenarioRootOps.missed(scenario(), { ending: "failed", summary: "", labels: [] }),
    ).toEqual([]);
  });
});
