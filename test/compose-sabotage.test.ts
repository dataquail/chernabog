// Whether the comparison of a document's flow with its recipe can fail: each
// of these breaks a generated flow in one way a person or a bug could, and the
// comparison must see it. A comparison that passes everything says nothing.

import { type Flow } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import epic from "../packages/recipes/flows/epic.ts";
import implement from "../packages/recipes/flows/implement.ts";
import review from "../packages/recipes/flows/review.ts";
import {
  documentOf,
  EPIC_DOCUMENT,
  generated,
  IMPLEMENT_DOCUMENT,
  loadSource,
  REVIEW_DOCUMENT,
  REVIEW_WITH_STAGE_DOCUMENT,
} from "./compose-harness.ts";
import {
  EPIC_SCENARIOS,
  EPIC_WORK_ITEM,
  IMPLEMENT_SCENARIOS,
  IMPLEMENT_WORK_ITEM,
  observe,
  REVIEW_SCENARIOS,
  REVIEW_WORK_ITEM,
  type Scenario,
  stageElsewhere,
  stageSkipping,
  throughStage,
} from "./compose-scenarios.ts";
import { effect } from "./effect-test.ts";

type Target = {
  readonly name: string;
  readonly recipe: Flow;
  readonly source: string;
  readonly work: Parameters<typeof observe>[3];
  readonly scenarios: ReadonlyArray<Scenario>;
};

const targets = {
  implement: {
    name: "implement",
    recipe: implement,
    source: generated(documentOf(IMPLEMENT_DOCUMENT)),
    work: IMPLEMENT_WORK_ITEM,
    scenarios: IMPLEMENT_SCENARIOS,
  },
  review: {
    name: "review",
    recipe: review,
    source: generated(documentOf(REVIEW_DOCUMENT)),
    work: REVIEW_WORK_ITEM,
    scenarios: REVIEW_SCENARIOS,
  },
  epic: {
    name: "epic",
    recipe: epic,
    source: generated(documentOf(EPIC_DOCUMENT)),
    work: EPIC_WORK_ITEM,
    scenarios: EPIC_SCENARIOS,
  },
} satisfies Record<string, Target>;

// The step `id`, written out of the flow, or as `standIn` where it was.
const dropping =
  (id: string, standIn = "") =>
  (source: string) =>
    source.replace(new RegExp(`const ${id} = yield\\* [^\\n]*`), standIn);

const sabotaged = (
  title: string,
  target: Target,
  scenarioTitle: string,
  sabotage: (source: string) => string,
) => {
  effect(
    title,
    () =>
      Effect.gen(function* () {
        const source = sabotage(target.source);

        // A sabotage whose text no longer matches would pass by doing nothing.
        expect(source).not.toBe(target.source);

        const [scenario] = target.scenarios.filter((each) => each.title === scenarioTitle);
        const { settings, setup, wake } = scenario;
        const flow = yield* loadSource(source);

        const fromRecipe = yield* observe(
          target.recipe,
          target.name,
          setup,
          target.work,
          wake,
          settings,
        );

        const fromFlow = yield* observe(flow, target.name, setup, target.work, wake, settings);

        expect(fromFlow).not.toEqual(fromRecipe);
      }),
    60_000,
  );
};

describe("the comparison sees an implement flow that", () => {
  const { implement: target } = targets;

  sabotaged(
    "doesn't hand off",
    target,
    "when the work goes for review",
    dropping("done", 'const done = "x";'),
  );

  sabotaged("skips the local gate", target, "when the work goes for review", dropping("gate"));

  sabotaged("doesn't let its claim go", target, "when the work goes for review", (source) =>
    source.replace("{ claims: true }", "{ claims: false }"),
  );

  sabotaged(
    "forgets its pull request when it fails",
    target,
    "when CI is red and stays red",
    (source) => source.replace("failureContext.pr = Option.some(opened.number);", ""),
  );
});

describe("the comparison sees a review flow that", () => {
  const { review: target } = targets;

  sabotaged(
    "never lands",
    target,
    "when it approves a pull request on the automated path",
    dropping("land", 'const land = "x";'),
  );

  sabotaged("takes changes asked for as approval", target, "when it asks for changes", (source) =>
    source.replace('outcomes["changes"]', 'outcomes["approve"]'),
  );
});

describe("the comparison sees an epic flow that", () => {
  const { epic: target } = targets;
  const opens = "when it opens every ready task's pull request and parks";

  sabotaged(
    "doesn't carry a change up its stack",
    target,
    opens,
    dropping("carried", "const carried = { moved: false, stack: state.stack };"),
  );

  sabotaged("never lands", target, "when its layers ship", (source) =>
    source.replace("const landed = ships.value === true ?", "const landed = false ?"),
  );

  sabotaged("posts no status", target, opens, dropping("status"));

  sabotaged(
    "doesn't note what its tasks waited on",
    target,
    opens,
    dropping("noted", "const noted = { tasks: state.tasks };"),
  );

  sabotaged(
    "keeps a task's claim after its questions",
    target,
    "when a task's agent has questions",
    dropping("released"),
  );

  sabotaged(
    "forgets a task's pull request when it fails",
    target,
    "when a task's CI stays red, and it goes to a person",
    (source) => source.replace("failureContext.pr = Option.some(published.pr.number);", ""),
  );
});

describe("the checks of a document that runs a stage see a flow that", () => {
  const source = generated(documentOf(REVIEW_WITH_STAGE_DOCUMENT));

  const [approved] = REVIEW_SCENARIOS.filter(
    (each) => each.title === "when it approves a pull request on the automated path",
  );

  const breaking = <E>(
    title: string,
    sabotage: (source: string) => string,
    check: (
      flow: Flow,
    ) => Effect.Effect<void, E, Effect.Services<ReturnType<typeof stageSkipping>>>,
  ) => {
    effect(
      title,
      () =>
        Effect.gen(function* () {
          const broken = sabotage(source);

          expect(broken).not.toBe(source);

          yield* check(yield* loadSource(broken));
        }),
      60_000,
    );
  };

  breaking(
    "doesn't run its stage",
    dropping("which", "const which = { pr: trigger.pr };"),
    (flow) =>
      Effect.gen(function* () {
        const { first, flow: fromFlow, recipe } = yield* throughStage(flow, review, approved);

        expect({ first, fromFlow }).not.toEqual({ first: "which-pr", fromFlow: recipe });
      }),
  );

  breaking(
    "takes the trigger's pull request instead of its stage's",
    (text) => text.replaceAll('"pr": which.pr', '"pr": trigger.pr'),
    (flow) =>
      Effect.gen(function* () {
        expect((yield* stageElsewhere(flow)).steps).not.toContain("merge-pr-107");
      }),
  );

  breaking(
    "fails the run where its stage skips it",
    (text) => text.replace('"Skip":"skip"', '"Skip":"fail"'),
    (flow) =>
      Effect.gen(function* () {
        expect((yield* stageSkipping(flow)).status).not.toBe("skipped");
      }),
  );
});
