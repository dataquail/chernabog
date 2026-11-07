// That `bun run test:composed` really does run the recipes' suites on their
// documents' flows. Without its preload, this has nothing to say.

import { expect } from "bun:test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import * as Epic from "../packages/recipes/flows/epic.ts";
import * as Implement from "../packages/recipes/flows/implement.ts";
import * as ReReview from "../packages/recipes/flows/re-review.ts";
import * as Review from "../packages/recipes/flows/review.ts";
import { effect } from "./effect-test.ts";

effect("the recipes these suites import are their documents' flows", () =>
  Effect.gen(function* () {
    const composed = yield* Config.option(Config.String("CHERNABOG_TEST_COMPOSED"));

    for (const recipe of [Epic, Implement, Review, ReReview]) {
      expect(Predicate.hasProperty(recipe, "composedFromDocument")).toBe(Option.isSome(composed));
    }
  }),
);
