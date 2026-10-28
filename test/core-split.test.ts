import * as Core from "@chernabog/core";
import * as Sdk from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";

import * as Claims from "../packages/core/src/claims.ts";
import { MergeRefused, NeedsHuman, Skip, StepFailed } from "../packages/core/src/errors.ts";
import { activity, awaitSignal, defineFlow, gone, sleep, step } from "../packages/core/src/flow.ts";
import { builtIn } from "../packages/core/src/github-markers.ts";
import { claimMarker, sessionMarker } from "../packages/core/src/markers.ts";
import { pathsMatching } from "../packages/core/src/paths.ts";
import { define, MarkerHolds } from "../packages/core/src/run-markers.ts";
import {
  Agent,
  FlowPackage,
  Git,
  GitHub,
  Repo,
  Run,
  Usage,
  Worktree,
} from "../packages/core/src/services.ts";
import * as Hybrid from "../packages/sdk/src/hybrid.ts";
import * as Implement from "../packages/sdk/src/implement.ts";
import * as Issue from "../packages/sdk/src/issue.ts";
import * as Plan from "../packages/sdk/src/plan.ts";
import { renderPrompt } from "../packages/sdk/src/prompt.ts";
import * as PullRequest from "../packages/sdk/src/pull-request.ts";
import * as Review from "../packages/sdk/src/review.ts";

// @chernabog/core is what the binary promises every repo and provides its own
// copy of; @chernabog/sdk is the blocks a repo pins for itself, over core,
// which it re-exports so a flow imports from one package (#163). That core
// names no block is architecture.yaml's to check.
describe("core and the SDK", () => {
  const contract = {
    activity,
    Agent,
    awaitSignal,
    claimMarker,
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
    sessionMarker,
    Skip,
    sleep,
    step,
    StepFailed,
    Usage,
    Worktree,
  };

  const blocks = { Hybrid, Implement, Issue, Plan, PullRequest, renderPrompt, Review };

  test("core exports the contract, claims and markers among it", () => {
    for (const [name, value] of Object.entries(contract)) {
      expect(Core).toHaveProperty(name, value);
    }

    expect(Core.Claims).toBe(Claims);
    expect(Core.Markers).toHaveProperty("define", define);
    expect(Core.Markers).toHaveProperty("MarkerHolds", MarkerHolds);
    expect(Core.Markers).toHaveProperty("builtIn", builtIn);
  });

  test("core exports no block", () => {
    for (const name of Object.keys(blocks)) {
      expect(Core).not.toHaveProperty(name);
    }
  });

  test("the SDK re-exports core as it is, so flows and the binary share one copy", () => {
    for (const [name, value] of Object.entries(contract)) {
      expect(Sdk).toHaveProperty(name, value);
    }

    expect(Sdk.Claims).toBe(Core.Claims);
    expect(Sdk.Markers).toBe(Core.Markers);
  });

  test("the SDK exports the blocks", () => {
    for (const [name, value] of Object.entries({ Hybrid, Implement, Plan, Review, renderPrompt })) {
      expect(Sdk).toHaveProperty(name, value);
    }

    expect(Sdk.PullRequest).toHaveProperty("requestReview", PullRequest.requestReview);
    expect(Sdk.Issue).toBe(Issue);
    expect(Sdk.Implement.branchFor).toBe(Claims.branchFor);
  });
});
