import * as IssueSteps from "./issue.ts";
import * as PullRequestSteps from "./pull-request.ts";
import type * as Services from "./services.ts";

export * as Claims from "./claims.ts";
export * from "./errors.ts";
export * from "./flow.ts";
export * as Hybrid from "./hybrid.ts";
export * as Implement from "./implement.ts";
export * from "./json.ts";
export * from "./markers.ts";
export * from "./paths.ts";
export * as Plan from "./plan.ts";
export * from "./prompt.ts";
export * as Review from "./review.ts";
export * from "./roles.ts";
export * from "./services.ts";
export * from "./stage.ts";

// PullRequest and Issue are each both a type and the steps on one.
export const PullRequest = PullRequestSteps;

export type PullRequest = Services.PullRequest;

export const Issue = IssueSteps;

export type Issue = Services.Issue;
