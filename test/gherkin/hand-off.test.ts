// The in-process driver's own feature, two personas taking turns, run
// through the runner like any feature's entry file.

import { inProcess } from "../features/drivers/in-process.ts";
import { featureAt } from "../features/runner.ts";
import { handOffSteps } from "./hand-off-steps.ts";

featureAt("test/gherkin/fixtures/hand-off.feature", inProcess, handOffSteps);
