// The spec-changes spec (spec-changes.feature) on the in-process driver. Its
// sandbox entry is test/acceptance/spec-changes.feature.test.ts.

import { inProcess } from "./drivers/in-process.ts";
import { feature } from "./runner.ts";
import { specChangesSteps } from "./steps/spec-changes.ts";

feature("spec-changes", inProcess, specChangesSteps);
