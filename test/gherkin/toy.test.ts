// The toy feature, run through the runner on the memory driver like any
// feature's entry file: its scenarios, and each row of its outline, as tests.

import { featureAt } from "../features/runner.ts";
import { memory } from "./memory-driver.ts";
import { toySteps } from "./toy-steps.ts";

featureAt("test/gherkin/fixtures/toy.feature", memory, toySteps);
