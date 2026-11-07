// A generated flow must behave as the recipe it stands in for: each scenario
// runs through the engine twice, once as the recipe and once as its document's
// flow, and what each left must match.

import { DEFAULT_LABELS, type Flow, labelsOf, Settings, type WorkItem } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  queued,
  REVIEW_SCENARIOS,
  REVIEW_WORK_ITEM,
  type Scenario,
} from "./compose-scenarios.ts";
import { effect } from "./effect-test.ts";
import { type Fake, flowTriggered, ISSUE, makeFake } from "./sdk-fakes.ts";

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
    const { ends, settings, setup, wake } = scenario;
    const fromRecipe = yield* observe(recipe, name, setup, work, wake, settings);
    const fromDocument = yield* observe(composed, name, setup, work, wake, settings);

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

describe("a document's sources find what its recipe's trigger does", () => {
  const found = (flow: Flow, setup: () => Fake) => flowTriggered(setup(), flow);

  const both = () => {
    const fake = queued();
    fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible, DEFAULT_LABELS.ship]);

    return fake;
  };

  const requested = () => {
    const fake = makeFake("approve");
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];

    return fake;
  };

  for (const [title, setup] of [
    ["an eligible issue", () => queued()],
    ["an issue on the automated path", () => queued(DEFAULT_LABELS.ship)],
    ["an issue with both labels", both],
  ] as const) {
    effect(`implement, on ${title}`, () =>
      Effect.gen(function* () {
        const fromRecipe = yield* found(implement, setup);
        expect(fromRecipe).toHaveLength(1);
        expect(yield* found(yield* composedImplement, setup)).toEqual(fromRecipe);
      }),
    );
  }

  effect("review, on a pull request that asks for one", () =>
    Effect.gen(function* () {
      const fromRecipe = yield* found(review, requested);
      expect(fromRecipe).toHaveLength(1);
      expect(yield* found(yield* composedReview, requested)).toEqual(fromRecipe);
    }),
  );

  // Which label queues an issue doesn't depend on where a document lists it.
  describe("whatever order a document lists the labels in", () => {
    const listing = (labels: ReadonlyArray<"eligible" | "ship">) =>
      loadFlow({
        ...documentOf(IMPLEMENT_DOCUMENT),
        trigger: [{ use: "issues.queued", with: { labels } }],
      });

    const dataOf = (flow: Flow, setup: () => Fake) =>
      found(flow, setup).pipe(Effect.map((items) => items.map((each) => each.data)));

    const SHIPPING = { issue: ISSUE, label: DEFAULT_LABELS.ship };

    effect("an issue on the automated path is queued by its label", () =>
      Effect.gen(function* () {
        const shipping = () => queued(DEFAULT_LABELS.ship);
        expect(yield* dataOf(yield* listing(["ship"]), shipping)).toEqual([SHIPPING]);
        expect(yield* dataOf(yield* listing(["ship", "eligible"]), shipping)).toEqual([SHIPPING]);
      }),
    );

    effect("an eligible issue is queued by no label", () =>
      Effect.gen(function* () {
        const flow = yield* listing(["ship", "eligible"]);
        expect(yield* dataOf(flow, () => queued())).toEqual([{ issue: ISSUE }]);
      }),
    );

    effect(
      "a run of what a ship-only source finds does as the recipe's does",
      () =>
        Effect.gen(function* () {
          const flow = yield* listing(["ship"]);
          const shipping = () => queued(DEFAULT_LABELS.ship);
          const work = Option.getOrThrow(Arr.head(yield* found(flow, shipping)));
          const fromDocument = yield* observe(flow, "implement", shipping, work);
          expect(fromDocument).toEqual(yield* observe(implement, "implement", shipping, work));
          expect(fromDocument.issueLabels).toEqual([]);
          expect(fromDocument.pullLabels).toEqual([DEFAULT_LABELS.ship]);
        }),
      60_000,
    );
  });
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
