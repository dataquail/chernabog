// The feature runner (test/features/runner.ts, #581): which scenarios an
// entry runs, how outlines expand, how steps find their definitions, and that
// each way a feature can't run fails, naming the file and line, rather than
// skipping.

import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { Exec } from "../../src/platform/exec.ts";
import { effect, effectAtHomeWith } from "../effect-test.ts";
import { type Driver, type Plan, plan, runScenario } from "../features/runner.ts";
import { defineSteps } from "../features/steps/registry.ts";
import { memory } from "./memory-driver.ts";
import { toySteps } from "./toy-steps.ts";

const URI = "test/gherkin/inline.feature";

const planned = (source: string, driver = "memory") => plan(URI, source, driver, toySteps);

const runnable = <S>(feature: Plan<S>) =>
  feature.scenarios.filter((scenario) => scenario.problems.length === 0).map(({ name }) => name);

const problemsOf = <S>(feature: Plan<S>) => [
  ...feature.problems,
  ...feature.scenarios.flatMap((scenario) => scenario.problems),
];

// Planned for the real drivers' names: an entry knows those and its own.
const TAGGED = `Feature: tags
  @driver:sandbox
  Scenario: sandbox only
    When someone files 1 issues

  @driver:in-process
  Scenario: in-process only
    When someone files 1 issues

  @driver:sandbox @driver:in-process
  Scenario: both
    When someone files 1 issues
`;

describe("which scenarios an entry runs", () => {
  test("a scenario runs on the drivers its tags name, and no other", () => {
    expect(runnable(planned(TAGGED, "sandbox"))).toEqual(["sandbox only", "both"]);
    expect(runnable(planned(TAGGED, "in-process"))).toEqual(["in-process only", "both"]);
  });

  test("a scenario's driver tags add to its feature's", () => {
    const source = `@driver:in-process
Feature: inherited
  Scenario: the feature's driver
    When someone files 1 issues

  @driver:sandbox
  Scenario: the feature's and its own
    When someone files 1 issues
`;

    expect(runnable(planned(source, "in-process"))).toEqual([
      "the feature's driver",
      "the feature's and its own",
    ]);
    expect(runnable(planned(source, "sandbox"))).toEqual(["the feature's and its own"]);
  });

  test("a driver tag for an entry's own driver is known, though no other entry knows it", () => {
    const source = `Feature: own
  @driver:memory
  Scenario: memory
    When someone files 1 issues
`;

    expect(runnable(planned(source))).toEqual(["memory"]);
    expect(problemsOf(planned(source, "in-process"))[0]).toContain(
      "names no known driver: @driver:memory (known: in-process, sandbox, ci, live)",
    );
  });

  test("the ci and live drivers are known, though neither has an entry yet", () => {
    const source = `Feature: later drivers
  @driver:memory @driver:ci @driver:live
  Scenario: everywhere
    When someone files 1 issues
`;

    expect(problemsOf(planned(source))).toEqual([]);
    expect(runnable(planned(source))).toEqual(["everywhere"]);
  });

  test("the describe block is the feature's name", () => {
    expect(planned(TAGGED, "sandbox").title).toBe("tags");
  });
});

describe("outlines", () => {
  const OUTLINE = `@driver:memory
Feature: outlines
  Background:
    Given alice is a persona on this machine

  Scenario Outline: files <count>
    When someone files <count> issues

    Examples:
      | count |
      | 2     |
      | 3     |
`;

  test("each example row is a scenario, named with its row's line, after the background", () => {
    const feature = planned(OUTLINE);

    expect(runnable(feature)).toEqual([
      "files 2 (example at line 11)",
      "files 3 (example at line 12)",
    ]);
    expect(feature.scenarios[1]?.steps.map(({ at, text }) => `${at} ${text}`)).toEqual([
      `${URI}:4 Given alice is a persona on this machine`,
      `${URI}:7 When someone files 3 issues`,
    ]);
    expect(feature.scenarios[1]?.steps[1]?.matched.captures).toEqual([3]);
  });
});

describe("step definitions", () => {
  const steps = defineSteps(
    () => ({}),
    ({ Given, Then, When }) => [
      Given("{word} files {string} {int} times", () => Effect.void),
      When(/^the clock reads (\d+):(\d+)$/, () => Effect.void),
      Then("a {thing} in braces is literal", () => Effect.void),
    ],
  );

  const match = (text: string) =>
    steps.definitions.flatMap((definition) => Option.toArray(definition.match(text)));

  test("placeholders capture a word, a quoted string and an int, and match the whole step", () => {
    expect(match('bob files "a bug report" 3 times')).toEqual([["bob", "a bug report", 3]]);
    expect(match('bob files "a bug report" 3 times today')).toEqual([]);
    expect(match("a {thing} in braces is literal")).toEqual([[]]);
  });

  test("a RegExp captures its groups as strings, and must match the whole step", () => {
    expect(match("the clock reads 9:30")).toEqual([["9", "30"]]);
    expect(match("now the clock reads 9:30")).toEqual([]);
  });

  test("a step finds its definition whatever its keyword", () => {
    const source = `@driver:memory
Feature: keywords
  Scenario: Then a Given step
    Then alice is a persona on this machine
    But someone files 1 issues
`;

    expect(problemsOf(planned(source))).toEqual([]);
  });
});

describe("what can't run fails, naming the file and line", () => {
  test("a scenario with no driver tag", () => {
    const source = `Feature: untagged
  Scenario: nobody runs this
    When someone files 1 issues
`;

    expect(problemsOf(planned(source))).toEqual([
      `${URI}:2: "nobody runs this" has no @driver tag; tag it, or its Feature, with the drivers that run it`,
    ]);
  });

  test("a driver tag naming no known driver, even beside one that runs it", () => {
    const source = `Feature: unknown
  @driver:memory @driver:nonesuch
  Scenario: half known
    When someone files 1 issues
`;

    expect(problemsOf(planned(source))).toEqual([
      `${URI}:3: "half known" names no known driver: @driver:nonesuch (known: in-process, sandbox, ci, live, memory)`,
    ]);
  });

  test("a step no definition matches", () => {
    const source = `@driver:memory
Feature: undefined
  Scenario: an undefined step
    When someone files 1 issues
    And nothing defines this
`;

    expect(problemsOf(planned(source))).toEqual([
      `${URI}:5: no step definition matches "And nothing defines this"`,
    ]);
  });

  test("a step more than one definition matches, whatever their keywords", () => {
    const overlapping = defineSteps(
      () => ({}),
      ({ Given, Then }) => [
        Given("{word} happens", () => Effect.void),
        Then("it {word}", () => Effect.void),
      ],
    );

    const source = `@driver:memory
Feature: ambiguous
  Scenario: an ambiguous step
    When it happens
`;

    expect(problemsOf(plan(URI, source, "memory", overlapping))).toEqual([
      `${URI}:4: "When it happens" matches more than one step definition: Given({word} happens), Then(it {word})`,
    ]);
  });

  test("a feature file that won't parse", () => {
    const source = `@driver:memory
Feature: unparsable
  Scenario: ragged
    When someone files 1 issues
      | one | two |
      | three |
`;

    expect(problemsOf(planned(source))).toEqual([
      `${URI}:6: inconsistent cell count within the table`,
    ]);
  });

  test("a file with no feature in it", () => {
    expect(problemsOf(planned("# nothing here\n"))).toEqual([`${URI}: has no Feature`]);
  });

  test("an entry whose driver runs none of the feature's scenarios", () => {
    const source = `Feature: elsewhere
  @driver:in-process
  Scenario: not on memory
    When someone files 1 issues
`;

    expect(problemsOf(planned(source))).toEqual([`${URI}:1: no scenario runs on @driver:memory`]);
  });
});

describe("running a scenario", () => {
  const scenarioOf = (source: string) => Option.getOrThrow(Arr.head(planned(source).scenarios));

  effect("its steps run in order against the domain the driver opens", () =>
    runScenario(
      scenarioOf(`@driver:memory
Feature: runs
  Scenario: files and counts
    When someone files 2 issues
    And someone files an issue labelled "auto:ship"
    Then there are 3 issues
    And the issues are numbered 1, 2, 3
`),
      memory,
      toySteps,
    ),
  );

  effect("each scenario opens the driver afresh, and closing its scope closes it", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([]);

      const logged: Driver = {
        ...memory,
        open: Effect.acquireRelease(
          Ref.update(log, (now) => [...now, "open"]).pipe(Effect.andThen(memory.open)),
          () => Ref.update(log, (now) => [...now, "close"]),
        ),
      };

      const scenario = scenarioOf(`@driver:memory
Feature: fresh
  Scenario: one issue
    When someone files 1 issues
    Then there is 1 issue
`);

      yield* Effect.scoped(runScenario(scenario, logged, toySteps));
      yield* Effect.scoped(runScenario(scenario, logged, toySteps));

      expect(yield* Ref.get(log)).toEqual(["open", "close", "open", "close"]);
    }),
  );

  effect("a failing step fails the scenario at its line, with why", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        runScenario(
          scenarioOf(`@driver:memory
Feature: fails
  Scenario: miscounts
    When someone files 1 issues
    Then there are 5 issues
    And there is 1 issue
`),
          memory,
          toySteps,
        ),
      );

      expect(failed.message).toStartWith(`${URI}:5: "Then there are 5 issues" failed`);
      expect(failed.message).toContain("Expected length: 5");
    }),
  );

  effect("a scenario that can't run fails without opening the driver", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        runScenario(
          scenarioOf(`@driver:memory
Feature: undefined
  Scenario: an undefined step
    When nothing defines this
`),
          { ...memory, open: Effect.die("opened") },
          toySteps,
        ),
      );

      expect(failed.message).toBe(
        `${URI}:4: no step definition matches "When nothing defines this"`,
      );
    }),
  );
});

// The broken entry run as bun test runs a spec's entry, in parallel: every
// way a feature can't run shows as a failing test that says why.
effectAtHomeWith(Exec.layer)(
  "an entry's problems fail under bun test --parallel",
  () =>
    Effect.gen(function* () {
      const root = fileURLToPath(new URL("../..", import.meta.url));

      const { exitCode, stderr, stdout } = yield* Exec.use((exec) =>
        exec.run("bun", ["test", "--parallel", "./test/gherkin/fixtures/broken.entry.ts"], {
          cwd: root,
        }),
      );

      const output = stdout + stderr;
      const broken = "test/gherkin/fixtures/broken.feature";

      expect(exitCode).toBe(1);
      expect(output).toContain(" 0 pass");
      expect(output).toContain(" 7 fail");

      for (const said of [
        `${broken}:7: no step definition matches "When something nobody defined happens"`,
        `${broken}:11: "When something happens twice" matches more than one step definition`,
        `${broken}:13: "a scenario with no driver tag" has no @driver tag`,
        `${broken}:17: "a scenario naming no known driver" names no known driver: @driver:nonesuch`,
        `${broken}:23: "Then there are 5 issues" failed`,
        "test/gherkin/fixtures/unparsable.feature:8: inconsistent cell count within the table",
        "test/gherkin/fixtures/missing.feature: can't be read",
      ]) {
        expect(output).toContain(said);
      }
    }),
  60_000,
);
