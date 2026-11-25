// The review loop's spec (test/features/review-loop.feature) on the live
// driver: the scenarios tagged for it, on the real daemon with the fake
// agents, against a real scratch repo. It writes to that repo, so it runs
// only when a person configures it (test/features/drivers/live.ts says what
// the repo must have first):
//
//   CHERNABOG_FEATURES_LIVE_REPO=owner/scratch \
//   CHERNABOG_FEATURES_LIVE_PERSONAS=<writer>,<reviewer> \
//   bun test test/acceptance/review-loop.live.feature.test.ts
//
// Unconfigured, it registers one skipped test that says so. CI doesn't
// configure it, so it has no timings entry.

import { test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../effect-test.ts";
import { live } from "../features/drivers/live.ts";
import { configuredBy, HOW_TO_RUN } from "../features/drivers/live-github.ts";
import { feature, ScenarioFailed } from "../features/runner.ts";
import { reviewLoopSteps } from "../features/steps/review-loop.ts";

const configured = configuredBy(
  Option.fromUndefinedOr(process.env.CHERNABOG_FEATURES_LIVE_REPO),
  Option.fromUndefinedOr(process.env.CHERNABOG_FEATURES_LIVE_PERSONAS),
);

switch (configured.kind) {
  case "configured":
    feature("review-loop", live(configured.config), reviewLoopSteps);
    break;
  case "misconfigured":
    effect("the review loop on a real scratch repo", () =>
      Effect.fail(new ScenarioFailed({ message: configured.why })),
    );
    break;
  case "unconfigured":
    test.skip(`the review loop on a real scratch repo: run ${HOW_TO_RUN}`, () => {});
    break;
}
