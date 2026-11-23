// The review loop's spec (test/features/review-loop.feature) on the sandbox
// driver: the same scenarios and steps the in-process driver runs, through
// the real CLI and daemon.

import { sandbox } from "../features/drivers/sandbox.ts";
import { feature } from "../features/runner.ts";
import { reviewLoopSteps } from "../features/steps/review-loop.ts";

feature("review-loop", sandbox, reviewLoopSteps);
