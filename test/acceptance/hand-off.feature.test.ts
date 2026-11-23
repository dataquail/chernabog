// The drivers' own two-persona feature (test/gherkin/fixtures/hand-off.feature)
// on the sandbox driver: the same scenarios and steps the in-process driver
// runs, through the real CLI and daemon.

import { sandbox } from "../features/drivers/sandbox.ts";
import { featureAt } from "../features/runner.ts";
import { handOffSteps } from "../gherkin/hand-off-steps.ts";

featureAt("test/gherkin/fixtures/hand-off.feature", sandbox, handOffSteps);
