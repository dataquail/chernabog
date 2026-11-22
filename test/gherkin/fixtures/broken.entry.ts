// An entry whose every test fails, one for each way a feature can't run. Its
// name keeps it out of the suite's *.test.ts glob: the runner's tests run it
// on its own with `bun test --parallel ./test/gherkin/fixtures/broken.entry.ts`
// and check that it fails, and says why.

import * as Effect from "effect/Effect";

import { featureAt } from "../../features/runner.ts";
import { defineSteps } from "../../features/steps/registry.ts";
import { memory } from "../memory-driver.ts";
import { toySteps } from "../toy-steps.ts";

const overlapping = defineSteps(toySteps.initial, ({ When }) => [
  When("{word} happens twice", () => Effect.void),
  When("something happens {word}", () => Effect.void),
]);

const steps = {
  initial: toySteps.initial,
  definitions: [...toySteps.definitions, ...overlapping.definitions],
};

featureAt("test/gherkin/fixtures/broken.feature", memory, steps);

featureAt("test/gherkin/fixtures/unparsable.feature", memory, steps);

featureAt("test/gherkin/fixtures/missing.feature", memory, steps);
