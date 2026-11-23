// The review loop's spec (review-loop.feature) on the in-process driver. Its
// sandbox entry is test/acceptance/review-loop.feature.test.ts.

import { inProcess } from "./drivers/in-process.ts";
import { feature } from "./runner.ts";
import { reviewLoopSteps } from "./steps/review-loop.ts";

feature("review-loop", inProcess, reviewLoopSteps);
