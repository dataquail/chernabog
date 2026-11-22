// The drivers' own feature, two personas taking turns, on the in-process
// driver, run through the runner like any feature's entry file. Its sandbox
// entry is test/acceptance/hand-off.feature.test.ts.

import { inProcess } from "../features/drivers/in-process.ts";
import { featureAt } from "../features/runner.ts";
import { handOffSteps } from "./hand-off-steps.ts";

featureAt("test/gherkin/fixtures/hand-off.feature", inProcess, handOffSteps);
