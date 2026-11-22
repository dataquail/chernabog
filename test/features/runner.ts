// Runs a feature file as bun test tests (ADR 22, decision 6): the standalone
// Gherkin parser reads it and compiles it to pickles, one per scenario and
// per row of an outline's examples, and each pickle the driver runs becomes
// a test. There is no cucumber-js runtime, so --parallel, the timings split
// and the sandbox work as they do for any other test file.
//
// A feature's entry file, one per driver, is a single call:
//
//   feature("review-loop", inProcess, reviewLoopSteps);
//
// What can't run fails, and never skips, because a skipped spec looks like a
// passing one. A scenario with no @driver tag, a tag naming no known driver,
// a step no definition matches and a step more than one matches each fail
// the scenario's test without running it, as does a feature file that won't
// parse, and an entry whose driver runs none of the feature's scenarios. Each
// failure names the feature file and line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import {
  type Feature,
  type GherkinDocument,
  IdGenerator,
  type Pickle,
  type PickleStep,
  type Scenario,
  type Step,
} from "@cucumber/messages";
import type { BunServices } from "@effect/platform-bun";
import { describe } from "bun:test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { effect } from "../effect-test.ts";
import type { Domain, DomainFailed } from "./domain.ts";
import { type Matched, matching, type Steps } from "./steps/registry.ts";

// Where the specs are, relative to the repo root.
export const FEATURES = "test/features";

// The drivers a scenario's @driver tag may name, besides the one an entry
// runs: in-process (#582), sandbox (#583), ci and live (ADR 22, decision 7).
// ci and live are known before either has an entry, so a spec can be tagged
// for them; until it has one, nothing runs the scenario there. A tag naming
// anything else fails, since nothing would run it.
export const DRIVERS: ReadonlyArray<string> = ["in-process", "sandbox", "ci", "live"];

const DRIVER_TAG = "@driver:";

// A way of running chernabog behind the domain layer. `open` sets one up for
// a scenario, and closing the scope it is opened in takes it down.
export type Driver = {
  // What a scenario's tag calls it: @driver:<name>.
  readonly name: string;
  readonly open: Effect.Effect<Domain, DomainFailed, Scope.Scope | BunServices.BunServices>;
  // How long one scenario may take, in milliseconds.
  readonly timeout: number;
};

// Why a scenario's test failed: it couldn't run, or one of its steps failed.
export class ScenarioFailed extends Schema.TaggedError<
  ScenarioFailed,
  { readonly brand: "ScenarioFailed" }
>()("ScenarioFailed", {
  message: Schema.String,
}) {}

export type PlannedStep<S> = {
  // The step as the feature says it, keyword and all.
  readonly text: string;
  // Where it is: the feature file and line.
  readonly at: string;
  readonly matched: Matched<S>;
};

// A scenario this entry's driver runs, or one that can't run, which fails.
export type PlannedScenario<S> = {
  readonly name: string;
  readonly at: string;
  readonly steps: ReadonlyArray<PlannedStep<S>>;
  // Why it can't run; it runs when there are none.
  readonly problems: ReadonlyArray<string>;
};

export type Plan<S> = {
  // The feature's name, or its file's when it has none.
  readonly title: string;
  readonly scenarios: ReadonlyArray<PlannedScenario<S>>;
  // Why the feature as a whole can't run.
  readonly problems: ReadonlyArray<string>;
};

type Located = { readonly line: number; readonly keyword: string };

const stepsIndexed = (index: Map<string, Located>, steps: ReadonlyArray<Step>) => {
  for (const step of steps) {
    index.set(step.id, { line: step.location.line, keyword: step.keyword });
  }
};

const scenarioIndexed = (index: Map<string, Located>, scenario: Scenario) => {
  stepsIndexed(index, scenario.steps);

  for (const examples of scenario.examples) {
    for (const row of examples.tableBody) {
      index.set(row.id, { line: row.location.line, keyword: "" });
    }
  }
};

// Each step's and example row's line and keyword, by its AST node's id.
const locations = (feature: Feature) => {
  const index = new Map<string, Located>();

  for (const child of feature.children) {
    const ruleChildren = Option.toArray(Option.fromUndefinedOr(child.rule)).flatMap(
      (rule) => rule.children,
    );

    for (const { background, scenario } of [child, ...ruleChildren]) {
      Option.toArray(Option.fromUndefinedOr(background)).forEach((found) => {
        stepsIndexed(index, found.steps);
      });
      Option.toArray(Option.fromUndefinedOr(scenario)).forEach((found) => {
        scenarioIndexed(index, found);
      });
    }
  }

  return index;
};

const located = (index: Map<string, Located>, id: string) =>
  Option.fromUndefinedOr(index.get(id)).pipe(
    Option.getOrElse((): Located => ({ line: 0, keyword: "" })),
  );

const noDefinition = (at: string, text: string) => `${at}: no step definition matches "${text}"`;

const ambiguous = <S>(at: string, text: string, found: ReadonlyArray<Matched<S>>) =>
  `${at}: "${text}" matches more than one step definition: ${found
    .map((match) => `${match.definition.keyword}(${match.definition.pattern})`)
    .join(", ")}`;

const stepPlanned = <S>(
  steps: Steps<S>,
  index: Map<string, Located>,
  uri: string,
  step: PickleStep,
): Result.Result<PlannedStep<S>, string> => {
  const { keyword, line } = located(index, step.astNodeIds[0]);
  const text = `${keyword}${step.text}`;
  const at = `${uri}:${line}`;
  const found = matching(steps, step.text);

  if (found.length > 1) {
    return Result.fail(ambiguous(at, text, found));
  }

  return Option.match(Arr.head(found), {
    onNone: () => Result.fail(noDefinition(at, text)),
    onSome: (matched) => Result.succeed({ text, at, matched }),
  });
};

// The problems with a pickle's driver tags, and whether it runs on `driver`.
const driversOf = (pickle: Pickle, driver: string, at: string) => {
  const named = pickle.tags
    .map((tag) => tag.name)
    .filter((tag) => tag.startsWith(DRIVER_TAG))
    .map((tag) => tag.slice(DRIVER_TAG.length));

  const known = new Set([...DRIVERS, driver]);
  const unknown = named.filter((name) => !known.has(name));
  const problems: Array<string> = [];

  if (named.length === 0) {
    problems.push(
      `${at}: "${pickle.name}" has no @driver tag; tag it, or its Feature, with the drivers that run it`,
    );
  }

  if (unknown.length > 0) {
    const tags = unknown.map((name) => DRIVER_TAG + name).join(", ");

    problems.push(
      `${at}: "${pickle.name}" names no known driver: ${tags} (known: ${[...known].join(", ")})`,
    );
  }

  return { problems, runsHere: named.includes(driver) };
};

const lineOf = (pickle: Pickle) =>
  Option.toArray(Option.fromUndefinedOr(pickle.location)).map((location) => location.line)[0] ?? 0;

// A scenario's name, and an outline's example row's line after it, since
// every row of an outline has the outline's name.
const nameOf = (pickle: Pickle) => {
  if (pickle.astNodeIds.length > 1) {
    return `${pickle.name} (example at line ${lineOf(pickle)})`;
  }

  return pickle.name;
};

const scenarioPlanned = <S>(
  steps: Steps<S>,
  index: Map<string, Located>,
  uri: string,
  pickle: Pickle,
): PlannedScenario<S> => {
  const planned = pickle.steps.map((step) => stepPlanned(steps, index, uri, step));

  return {
    name: nameOf(pickle),
    at: `${uri}:${lineOf(pickle)}`,
    steps: Arr.getSuccesses(planned),
    problems: Arr.getFailures(planned),
  };
};

// The parser's errors, each as "(line:column): what", at the feature's file
// and line.
const parseProblem = (uri: string, error: string) => {
  const errors = error
    .split("\n")
    .flatMap((line) => Option.toArray(Option.fromNullishOr(/\((\d+):\d+\): (.*)$/.exec(line))))
    .map(([, line, what]) => `${uri}:${line}: ${what}`);

  if (errors.length === 0) {
    return `${uri}: ${error}`;
  }

  return errors.join("\n");
};

const parsed = (uri: string, source: string) =>
  Result.try({
    try: (): GherkinDocument =>
      new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher()).parse(
        source,
      ),
    catch: (error) => parseProblem(uri, String(error)),
  });

const scenariosOf = <S>(
  uri: string,
  driver: string,
  steps: Steps<S>,
  document: GherkinDocument,
  feature: Feature,
) => {
  const index = locations(feature);

  return compile(document, uri, IdGenerator.uuid()).flatMap((pickle): Array<PlannedScenario<S>> => {
    const at = `${uri}:${lineOf(pickle)}`;
    const tags = driversOf(pickle, driver, at);

    if (tags.problems.length > 0) {
      return [{ name: nameOf(pickle), at, steps: [], problems: tags.problems }];
    }

    if (tags.runsHere) {
      return [scenarioPlanned(steps, index, uri, pickle)];
    }

    return [];
  });
};

const plannedFeature = <S>(
  uri: string,
  driver: string,
  steps: Steps<S>,
  document: GherkinDocument,
): Plan<S> =>
  Option.match(Option.fromUndefinedOr(document.feature), {
    onNone: (): Plan<S> => ({ title: uri, scenarios: [], problems: [`${uri}: has no Feature`] }),
    onSome: (feature): Plan<S> => {
      const scenarios = scenariosOf(uri, driver, steps, document, feature);

      const title = Option.liftPredicate(feature.name, (name) => name !== "").pipe(
        Option.getOrElse(() => uri),
      );

      if (scenarios.length === 0) {
        const problem = `${uri}:${feature.location.line}: no scenario runs on ${DRIVER_TAG}${driver}`;

        return { title, scenarios, problems: [problem] };
      }

      return { title, scenarios, problems: [] };
    },
  });

// What an entry for `driver` runs of the feature at `uri` whose text is
// `source`: each scenario it runs, or why it can't.
export const plan = <S>(uri: string, source: string, driver: string, steps: Steps<S>): Plan<S> =>
  Result.match(parsed(uri, source), {
    onFailure: (problem): Plan<S> => ({ title: uri, scenarios: [], problems: [problem] }),
    onSuccess: (document) => plannedFeature(uri, driver, steps, document),
  });

const stepRun = <S>(
  scenario: { readonly domain: Domain; readonly state: S },
  step: PlannedStep<S>,
) =>
  Effect.suspend(() => step.matched.definition.run(scenario, step.matched.captures)).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new ScenarioFailed({
          message: `${step.at}: "${step.text}" failed\n${Cause.pretty(cause)}`,
        }),
      ),
    ),
  );

// Runs a planned scenario on a freshly opened driver, step by step, failing
// at the first step that fails with that step's file and line.
export const runScenario = <S>(scenario: PlannedScenario<S>, driver: Driver, steps: Steps<S>) =>
  Effect.gen(function* () {
    if (scenario.problems.length > 0) {
      return yield* new ScenarioFailed({ message: scenario.problems.join("\n") });
    }

    const domain = yield* driver.open.pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new ScenarioFailed({
            message: `${scenario.at}: the ${driver.name} driver didn't open\n${Cause.pretty(cause)}`,
          }),
        ),
      ),
    );

    const state = { domain, state: steps.initial() };

    yield* Effect.forEach(scenario.steps, (step) => stepRun(state, step), { discard: true });
  });

const sourceOf = (path: string) =>
  Result.try({
    try: () => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8"),
    catch: (error) => `${path}: can't be read: ${String(error)}`,
  });

// Registers the feature file at `path` (relative to the repo root) as one
// describe block, with a test for each scenario `driver` runs and a failing
// test for each problem.
export const featureAt = <S>(path: string, driver: Driver, steps: Steps<S>) => {
  const planned = Result.match(sourceOf(path), {
    onFailure: (problem): Plan<S> => ({ title: path, scenarios: [], problems: [problem] }),
    onSuccess: (source) => plan(path, source, driver.name, steps),
  });

  describe(`${planned.title} (${DRIVER_TAG}${driver.name})`, () => {
    for (const problem of planned.problems) {
      effect("the feature runs", () => Effect.fail(new ScenarioFailed({ message: problem })));
    }

    for (const scenario of planned.scenarios) {
      effect(scenario.name, () => runScenario(scenario, driver, steps), driver.timeout);
    }
  });
};

// Registers test/features/<name>.feature.
export const feature = <S>(name: string, driver: Driver, steps: Steps<S>) => {
  featureAt(`${FEATURES}/${name}.feature`, driver, steps);
};
