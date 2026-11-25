// The review loop's spec (test/features/review-loop.feature) on the ci
// driver: the scenarios tagged for it, through `ci plan` and `ci run` as a
// repo's GitHub Actions workflow runs them, with no daemon.

import { ci } from "../features/drivers/ci.ts";
import { feature } from "../features/runner.ts";
import { reviewLoopSteps } from "../features/steps/review-loop.ts";

feature("review-loop", ci, reviewLoopSteps);
