// The CI plan job's guards (#459): what the bundled recipes declare (#457),
// routed by the SDK's Events as `chernabog ci plan` routes them, decides which
// flows and items the plan looks at. An event a guard refuses leaves nothing
// to look at, so the plan runs no trigger and prints [].

import type { Json } from "@chernabog/core";
import { Events } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import implementRecipe from "../packages/recipes/flows/implement.ts";
import reviewRecipe from "../packages/recipes/flows/review.ts";
import { CiPlan } from "../src/modules/runs/domain/domain-services/ci-plan.domain-service.ts";

const flows = [
  { flow: "implement", personas: ["author-bot"], recipe: implementRecipe },
  { flow: "review", personas: ["review-bot"], recipe: reviewRecipe },
];

const WorkflowRun = Schema.Struct({ workflow_run: Schema.Struct({ name: Schema.String }) });

// The routes for an event, as the plan job builds them: a workflow_run reached
// it only because the workflow's on: block names the run's workflow, so that
// one is the repo's CI workflow, unless it is chernabog's own.
const routesFor = (event: string, payload: Json) =>
  Events.workflowOn(
    flows.map(({ flow, personas, recipe }) => ({
      flow,
      personas,
      declared: Option.getOrThrow(Events.of(recipe)),
    })),
    {
      ciWorkflows: Option.toArray(
        Option.map(
          Option.filter(
            Schema.decodeUnknownOption(WorkflowRun)(payload),
            () => event === "workflow_run",
          ),
          (run) => run.workflow_run.name,
        ),
      ),
      own: "chernabog",
    },
  ).routes;

// The targets of the plan for an event, as the plan job works them out.
const targetsFor = (event: string, payload: Json) =>
  CiPlan.targets(
    flows.map(({ flow, personas }) => ({ flow, personas })),
    { kind: "event", woken: Events.wokenBy(routesFor(event, payload), event, payload) },
  );

describe("the plan job's guards", () => {
  test("a label a maintainer applies looks at that issue, for the flow it queues", () => {
    expect(
      targetsFor("issues", {
        action: "labeled",
        issue: { number: 12 },
        sender: { login: "a-maintainer" },
      }),
    ).toEqual([
      {
        flow: "implement",
        persona: "author-bot",
        only: Option.some([{ kind: "issue", number: 12 }]),
      },
    ]);
  });

  test("an event the flow's own persona caused wakes nothing", () => {
    expect(
      targetsFor("issues", {
        action: "labeled",
        issue: { number: 12 },
        sender: { login: "Author-Bot" },
      }),
    ).toEqual([]);
  });

  test("a review by someone the repo doesn't trust wakes nothing", () => {
    expect(
      targetsFor("pull_request_review", {
        action: "submitted",
        pull_request: { number: 7, author_association: "MEMBER" },
        review: { author_association: "NONE" },
        sender: { login: "a-stranger" },
      }),
    ).toEqual([]);
  });

  test("an activity type no flow declares wakes nothing", () => {
    expect(
      targetsFor("issues", {
        action: "opened",
        issue: { number: 12 },
        sender: { login: "a-maintainer" },
      }),
    ).toEqual([]);
  });

  test("a run of the repo's CI finishing looks at what its branch names", () => {
    const targets = targetsFor("workflow_run", {
      action: "completed",
      workflow_run: { name: "CI", head_branch: "auto/issue-12" },
      sender: { login: "author-bot" },
    });

    expect(targets.map((target) => [target.flow, target.only])).toContainEqual([
      "review",
      Option.some([{ kind: "branch", name: "auto/issue-12" }]),
    ]);
  });

  test("a run of chernabog's own workflow finishing wakes nothing", () => {
    expect(
      targetsFor("workflow_run", {
        action: "completed",
        workflow_run: { name: "chernabog", head_branch: "auto/issue-12" },
        sender: { login: "a-maintainer" },
      }),
    ).toEqual([]);
  });
});
