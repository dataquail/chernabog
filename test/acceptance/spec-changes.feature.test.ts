// The spec-changes spec (test/features/spec-changes.feature) on the sandbox
// driver: the same scenarios and steps the in-process driver runs, through
// the real CLI and daemon.

import { sandbox } from "../features/drivers/sandbox.ts";
import { feature } from "../features/runner.ts";
import { specChangesSteps } from "../features/steps/spec-changes.ts";

feature("spec-changes", sandbox, specChangesSteps);
