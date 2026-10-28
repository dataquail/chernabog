import * as Sdk from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";

import { MergeRefused, NeedsHuman, Skip, StepFailed } from "../packages/sdk/src/abi/errors.ts";
import {
  activity,
  awaitSignal,
  defineFlow,
  gone,
  sleep,
  step,
} from "../packages/sdk/src/abi/flow.ts";
import { pathsMatching } from "../packages/sdk/src/abi/paths.ts";
import {
  Agent,
  FlowPackage,
  Git,
  GitHub,
  Repo,
  Run,
  Usage,
  Worktree,
} from "../packages/sdk/src/abi/services.ts";
import * as Claims from "../packages/sdk/src/blocks/claims.ts";
import * as Hybrid from "../packages/sdk/src/blocks/hybrid.ts";
import * as Implement from "../packages/sdk/src/blocks/implement.ts";
import * as Issue from "../packages/sdk/src/blocks/issue.ts";
import { claimMarker } from "../packages/sdk/src/blocks/markers.ts";
import * as Plan from "../packages/sdk/src/blocks/plan.ts";
import { renderPrompt } from "../packages/sdk/src/blocks/prompt.ts";
import * as PullRequest from "../packages/sdk/src/blocks/pull-request.ts";
import * as Review from "../packages/sdk/src/blocks/review.ts";

// @chernabog/sdk is the flow ABI (what the binary promises every repo) and
// the blocks (the library a recipe is written from), side by side until the
// blocks ship as their own package (#163). That the ABI names no block is
// architecture.yaml's to check.
describe("the SDK's split into ABI and blocks", () => {
  test("the SDK exports the ABI's contract as it is", () => {
    const abi = {
      activity,
      Agent,
      awaitSignal,
      defineFlow,
      FlowPackage,
      Git,
      GitHub,
      gone,
      MergeRefused,
      NeedsHuman,
      pathsMatching,
      Repo,
      Run,
      Skip,
      sleep,
      step,
      StepFailed,
      Usage,
      Worktree,
    };

    for (const [name, value] of Object.entries(abi)) {
      expect(Sdk).toHaveProperty(name, value);
    }
  });

  test("the SDK exports the blocks as they are", () => {
    const blocks = {
      Claims,
      claimMarker,
      Hybrid,
      Implement,
      Issue,
      Plan,
      PullRequest,
      renderPrompt,
      Review,
    };

    for (const [name, value] of Object.entries(blocks)) {
      expect(Sdk).toHaveProperty(name, value);
    }
  });

  test("PullRequest and Issue are still the blocks' steps", () => {
    expect(Sdk.PullRequest).toHaveProperty("requestReview", PullRequest.requestReview);
    expect(Sdk.Issue).toBe(Issue);
  });
});
