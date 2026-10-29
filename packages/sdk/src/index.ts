import type * as Core from "@chernabog/core";

import * as IssueSteps from "./issue.ts";
import * as PullRequestSteps from "./pull-request.ts";

// @chernabog/sdk: the blocks a recipe is written from, over core's ports and
// nothing else, and core itself, so a flow imports from one package. A repo
// pins its own version; the binary only provides core.
export * as Epic from "./epic.ts";
export * as Hybrid from "./hybrid.ts";
export * as Implement from "./implement.ts";
export * as Plan from "./plan.ts";
export * from "./prompt.ts";
export * as Review from "./review.ts";
export * as Routing from "./routing.ts";
export * as Settings from "./settings.ts";
export * as Stack from "./stack.ts";
export * from "@chernabog/core";

// PullRequest and Issue are each both a type, core's, and the steps on one;
// these win over core's types of the same name.
export const PullRequest = PullRequestSteps;

export type PullRequest = Core.PullRequest;

export const Issue = IssueSteps;

export type Issue = Core.Issue;
