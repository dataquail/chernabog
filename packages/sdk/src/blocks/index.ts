import type * as Services from "../abi/services.ts";
import * as IssueSteps from "./issue.ts";
import * as PullRequestSteps from "./pull-request.ts";

// The blocks: the library a recipe is written from, over the ABI's ports and
// nothing else (#163).
export * as Claims from "./claims.ts";
export * as Hybrid from "./hybrid.ts";
export * as Implement from "./implement.ts";
export * from "./markers.ts";
export * as Markers from "./markers-api.ts";
export * as Plan from "./plan.ts";
export * from "./prompt.ts";
export * as Review from "./review.ts";

// PullRequest and Issue are each both a type and the steps on one.
export const PullRequest = PullRequestSteps;

export type PullRequest = Services.PullRequest;

export const Issue = IssueSteps;

export type Issue = Services.Issue;
