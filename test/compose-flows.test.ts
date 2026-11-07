// A generated flow must behave as the recipe it stands in for: each scenario
// runs through the engine twice, once as the recipe and once as its document's
// flow, and what each left must match.

import { type Flow, labelsOf, Settings, type WorkItem } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import epic from "../packages/recipes/flows/epic.ts";
import implement from "../packages/recipes/flows/implement.ts";
import review from "../packages/recipes/flows/review.ts";
import {
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  loadFlow,
  REVIEW_DOCUMENT,
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
} from "./compose-scenarios.ts";
import { effect } from "./effect-test.ts";
import { makeFake } from "./sdk-fakes.ts";

const composedImplement = loadFlow(documentOf(IMPLEMENT_DOCUMENT));

const composedReview = loadFlow(documentOf(REVIEW_DOCUMENT));

const composedEpic = loadFlow(documentOf(EPIC_DOCUMENT));

const runsAsTheRecipe = <E, R>(
  name: string,
  recipe: Flow,
  loading: Effect.Effect<Flow, E, R>,
  work: WorkItem,
  scenario: Scenario,
) =>
  Effect.gen(function* () {
    const composed = yield* loading;
    const { ends, on, setup, wake } = scenario;
    const fromRecipe = yield* observe(recipe, name, setup, work, wake, on);
    const fromDocument = yield* observe(composed, name, setup, work, wake, on);

    expect(fromRecipe.status).toBe(ends);
    expect(fromDocument).toEqual(fromRecipe);
  });

describe("the implement document runs as the recipe does", () => {
  for (const scenario of IMPLEMENT_SCENARIOS) {
    effect(
      scenario.title,
      () =>
        runsAsTheRecipe("implement", implement, composedImplement, IMPLEMENT_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("the review document runs as the recipe does", () => {
  for (const scenario of REVIEW_SCENARIOS) {
    effect(
      scenario.title,
      () => runsAsTheRecipe("review", review, composedReview, REVIEW_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("the epic document runs as the recipe does", () => {
  for (const scenario of EPIC_SCENARIOS) {
    effect(
      scenario.title,
      () => runsAsTheRecipe("epic", epic, composedEpic, EPIC_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("a document's flow declares what its recipe does", () => {
  const settingsKeys = (flow: Flow) => {
    const { settings } = flow;

    if (Predicate.hasProperty(settings, "fields") && Predicate.isObject(settings.fields)) {
      return Object.keys(settings.fields).toSorted();
    }

    return [];
  };

  const declared = (flow: Flow) => ({
    settings: settingsKeys(flow),
    concurrency: flow.concurrency,
    ownWork: flow.ownWork === true,
    doctor: flow.doctor,
    stillValid: flow.stillValid,
    gate: flow.gate,
  });

  const labelled = (flow: Flow) =>
    labelsOf(flow).pipe(
      Effect.provideService(Settings.FlowSettings, { input: {} }),
      Effect.provide(makeFake("approve").services),
    );

  effect("implement", () =>
    Effect.gen(function* () {
      const composed = yield* composedImplement;
      expect(declared(composed)).toEqual(declared(implement));
      expect(yield* labelled(composed)).toEqual(yield* labelled(implement));
    }),
  );

  effect("epic", () =>
    Effect.gen(function* () {
      const composed = yield* composedEpic;
      expect(declared(composed)).toEqual(declared(epic));
      expect(yield* labelled(composed)).toEqual(yield* labelled(epic));
    }),
  );

  effect("review", () =>
    Effect.gen(function* () {
      const composed = yield* composedReview;
      expect(declared(composed)).toEqual(declared(review));
      expect(yield* labelled(composed)).toEqual(yield* labelled(review));
    }),
  );
});
