// The GitHub events that wake each flow (#457): what the catalogue's sources
// and wakes declare, what a document's flow and a recipe written in
// TypeScript carry, and the workflow's `on:` block and the map from an event
// to the flows and items it concerns, built from a repo's flows that run in CI.

import { Blocks, Compose, Events } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import addressReviewRecipe from "../packages/recipes/flows/address-review.ts";
import epicRecipe from "../packages/recipes/flows/epic.ts";
import implementRecipe from "../packages/recipes/flows/implement.ts";
import planRecipe from "../packages/recipes/flows/plan.ts";
import postMergeRecipe from "../packages/recipes/flows/post-merge.ts";
import reReviewRecipe from "../packages/recipes/flows/re-review.ts";
import resolveConflictsRecipe from "../packages/recipes/flows/resolve-conflicts.ts";
import reviewRecipe from "../packages/recipes/flows/review.ts";
import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  IMPLEMENT_DOCUMENT,
  PLAN_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";

const Declared = Schema.Array(
  Schema.Struct({
    event: Schema.String,
    types: Schema.Array(Schema.String),
    item: Schema.Struct({ kind: Schema.String, path: Schema.optionalKey(Schema.String) }),
    association: Schema.optionalKey(Schema.String),
    trusted: Schema.Boolean,
    ownPersona: Schema.Boolean,
  }),
);

const catalogue = Schema.decodeUnknownSync(
  Schema.Struct({
    sources: Schema.Array(Schema.Struct({ name: Schema.String, events: Declared })),
    blocks: Schema.Array(
      Schema.Struct({ name: Schema.String, wakeEvents: Schema.optionalKey(Declared) }),
    ),
  }),
)(Compose.describe());

const sourceNamed = (name: string) => catalogue.sources.find((source) => source.name === name);

const blockNamed = (name: string) => catalogue.blocks.find((block) => block.name === name);

const kinds = (
  declared: ReadonlyArray<{ readonly event: string; readonly types: ReadonlyArray<string> }>,
) => declared.map((each) => `${each.event}: ${each.types.join(", ")}`);

// resolve-conflicts' document without its wait for CI, which parks: its
// sources read no phase.
const NO_PARK_DOCUMENT = RESOLVE_CONFLICTS_DOCUMENT.replace(
  / {2}- id: ci\n[\s\S]*?(?= {2}- id: again)/,
  "",
);

describe("the catalogue's events", () => {
  test("every source names the events it depends on", () => {
    expect(catalogue.sources.length).toBeGreaterThan(0);

    expect(
      Object.fromEntries(catalogue.sources.map((source) => [source.name, kinds(source.events)])),
    ).toEqual({
      "epic.queued": [
        "issues: labeled",
        "issues: closed, labeled, unlabeled",
        "pull_request: synchronize",
        "pull_request_review: submitted",
        "pull_request: closed",
      ],
      "issues.queued": ["issues: labeled"],
      "plan.queued": ["issues: labeled"],
      "pr.conflicting": ["pull_request: closed"],
      "pr.mergedRecently": ["pull_request: closed"],
      "review.changesRequested": ["pull_request_review: submitted"],
      "review.requested": ["pull_request: review_requested, ready_for_review"],
      "review.requestedAgain": ["pull_request: review_requested"],
      "review.waitingElsewhere": [],
    });
  });

  test("each says how the payload names the item, and the guards it keeps", () => {
    expect(sourceNamed("review.changesRequested")?.events).toEqual([
      {
        event: "pull_request_review",
        types: ["submitted"],
        item: { kind: "pull-request", path: "pull_request.number" },
        association: "review.author_association",
        trusted: true,
        ownPersona: false,
      },
    ]);

    // A merge may move the base under every open pull request, and the
    // persona's own merge counts.
    expect(sourceNamed("pr.conflicting")?.events).toEqual([
      {
        event: "pull_request",
        types: ["closed"],
        item: { kind: "repo" },
        trusted: true,
        ownPersona: true,
      },
    ]);
  });

  test("an epic wakes on what moves its layers, for every item, since none names the epic", () => {
    const layers = (sourceNamed("epic.queued")?.events ?? []).slice(1);

    expect(layers.map((each) => each.item)).toEqual(layers.map(() => ({ kind: "repo" })));
    // A task closed by the persona's own merge, and the merge itself, count.
    expect(layers.map((each) => each.ownPersona)).toEqual([true, false, false, true]);
    expect(layers[2]?.association).toBe("review.author_association");
  });

  test("a block whose wakes find parked runs names the events that settle the wait", () => {
    expect(kinds(blockNamed("pr.land")?.wakeEvents ?? [])).toEqual(["workflow_run: completed"]);
    expect(kinds(blockNamed("pr.awaitReady")?.wakeEvents ?? [])).toEqual([
      "pull_request: ready_for_review",
    ]);
    expect(kinds(blockNamed("plan.awaitAnswer")?.wakeEvents ?? [])).toEqual([
      "issue_comment: created",
    ]);
    expect(blockNamed("pr.land")?.wakeEvents?.[0]?.item).toEqual({
      kind: "branch",
      path: "workflow_run.head_branch",
    });
  });

  test("nothing declares check_suite, pull_request_target or a phase event", () => {
    const declared = [
      ...catalogue.sources.flatMap((source) => source.events),
      ...catalogue.blocks.flatMap((block) => block.wakeEvents ?? []),
    ].map((each) => each.event);

    expect(declared).not.toContain("check_suite");
    expect(declared).not.toContain("pull_request_target");
    expect(declared).not.toContain("repository_dispatch");
  });

  test("a declaration naming an event no flow may wake on is refused", () => {
    const declaring = (event: string) =>
      Schema.is(Events.WakingEvent)({
        event,
        types: ["completed"],
        item: { kind: "repo" },
        trusted: true,
        ownPersona: false,
      });

    expect(declaring("check_suite")).toBe(false);
    expect(declaring("pull_request_target")).toBe(false);
    expect(declaring("repository_dispatch")).toBe(false);
    expect(declaring("workflow_run")).toBe(true);
  });

  test("a declaration may name the item by its claim's name", () => {
    expect(
      Events.on("issues", ["labeled"], { kind: "item", path: "client_payload.item" }).item,
    ).toEqual({ kind: "item", path: "client_payload.item" });
  });

  test("the guards are on unless a declaration opts out", () => {
    const declared = Events.on("issues", ["labeled"], { kind: "issue", path: "issue.number" });

    expect(declared.trusted).toBe(true);
    expect(declared.ownPersona).toBe(false);
  });
});

describe("a flow's events", () => {
  test("a document's are its sources' and its blocks' wakes'", () => {
    const review = Compose.eventsOf(documentOf(REVIEW_DOCUMENT));

    expect(kinds(review.events)).toEqual([
      "pull_request: review_requested, ready_for_review",
      "workflow_run: completed",
    ]);
    expect(review.readsPhases).toBe(true);
  });

  test("a document whose sources read no phase isn't woken by a phase event", () => {
    expect(Compose.eventsOf(documentOf(NO_PARK_DOCUMENT)).readsPhases).toBe(false);
    // Its wait for CI parks, and the record it parks on wakes it.
    expect(Compose.eventsOf(documentOf(RESOLVE_CONFLICTS_DOCUMENT)).readsPhases).toBe(true);
    expect(Compose.eventsOf(documentOf(ADDRESS_REVIEW_DOCUMENT)).readsPhases).toBe(true);
  });

  test("a flow assembled from a document carries them", () => {
    const flow = Blocks.assemble({
      subject: "pull-request",
      sources: [Blocks.sources["review.requested"].find()],
      blocks: ["review.round", "pr.land"],
      workflow: () => Effect.void,
    });

    expect(Option.map(Events.of(flow), (declared) => kinds(declared.events))).toEqual(
      Option.some(["pull_request: review_requested, ready_for_review", "workflow_run: completed"]),
    );
    expect(Option.map(Events.of(flow), (declared) => declared.readsPhases)).toEqual(
      Option.some(true),
    );
    // Not among its keys, which stay those of a recipe written in TypeScript.
    expect(Object.keys(flow)).not.toContain("events");
  });

  test("a flow declared again carries what it was declared with last", () => {
    const assembled = Blocks.assemble({
      subject: "pull-request",
      sources: [Blocks.sources["review.requested"].find()],
      blocks: ["review.round"],
      workflow: () => Effect.void,
    });

    const redeclared = Events.declare(assembled, {
      events: [Events.issueLabelled],
      readsPhases: false,
    });

    expect(Option.map(Events.of(redeclared), (declared) => kinds(declared.events))).toEqual(
      Option.some(["issues: labeled"]),
    );
  });

  test("each recipe written in TypeScript declares its own through the SDK", () => {
    const declared = Object.fromEntries(
      Object.entries({
        "address-review": addressReviewRecipe,
        epic: epicRecipe,
        implement: implementRecipe,
        plan: planRecipe,
        "post-merge": postMergeRecipe,
        "re-review": reReviewRecipe,
        "resolve-conflicts": resolveConflictsRecipe,
        review: reviewRecipe,
      }).map(([name, flow]) => [
        name,
        Option.map(Events.of(flow), (found) => ({
          events: kinds(found.events),
          readsPhases: found.readsPhases,
        })),
      ]),
    );

    expect(declared).toEqual({
      "address-review": Option.some({
        events: ["pull_request_review: submitted", "workflow_run: completed"],
        readsPhases: true,
      }),
      epic: Option.some({
        events: [
          "issues: labeled",
          "issues: closed, labeled, unlabeled",
          "pull_request: synchronize",
          "pull_request_review: submitted",
          "pull_request: closed",
          "workflow_run: completed",
        ],
        readsPhases: true,
      }),
      implement: Option.some({
        events: ["issues: labeled", "pull_request: ready_for_review", "workflow_run: completed"],
        readsPhases: true,
      }),
      plan: Option.some({
        events: ["issues: labeled", "issue_comment: created"],
        readsPhases: false,
      }),
      "post-merge": Option.some({
        events: ["pull_request: closed", "workflow_run: completed"],
        readsPhases: false,
      }),
      "re-review": Option.some({
        events: ["pull_request: review_requested", "workflow_run: completed"],
        readsPhases: true,
      }),
      "resolve-conflicts": Option.some({
        events: ["pull_request: closed", "workflow_run: completed"],
        readsPhases: true,
      }),
      review: Option.some({
        events: ["pull_request: review_requested, ready_for_review", "workflow_run: completed"],
        readsPhases: true,
      }),
    });
  });
});

const ciFlow = (flow: string, source: string, personas: ReadonlyArray<string> = ["bot"]) => ({
  flow,
  personas,
  declared: Compose.eventsOf(documentOf(source)),
});

const repoFlows = [
  ciFlow("implement", IMPLEMENT_DOCUMENT),
  ciFlow("review", REVIEW_DOCUMENT, ["reviewer-a", "reviewer-b"]),
  ciFlow("address-review", ADDRESS_REVIEW_DOCUMENT),
  ciFlow("plan", PLAN_DOCUMENT),
];

describe("the workflow's on: block", () => {
  test("lists each event the flows declare once, with every type any of them needs", () => {
    const wiring = Events.workflowOn(repoFlows, { ciWorkflows: ["CI"], own: "chernabog" });

    expect(wiring.on).toEqual({
      issue_comment: { types: ["created"] },
      issues: { types: ["labeled"] },
      pull_request: { types: ["ready_for_review", "review_requested"] },
      pull_request_review: { types: ["submitted"] },
      repository_dispatch: { types: ["chernabog-phase"] },
      workflow_run: { workflows: ["CI"], types: ["completed"] },
    });
    expect(Object.keys(wiring.on)).toEqual([
      "issue_comment",
      "issues",
      "pull_request",
      "pull_request_review",
      "repository_dispatch",
      "workflow_run",
    ]);
    expect(wiring.notes).toEqual([]);
  });

  test("never filters workflow_run to chernabog's own workflow", () => {
    const wiring = Events.workflowOn(repoFlows, {
      ciWorkflows: ["chernabog", "Test", "CI"],
      own: "chernabog",
    });

    expect(wiring.on.workflow_run).toEqual({ workflows: ["CI", "Test"], types: ["completed"] });
  });

  test("leaves workflow_run out, and says so, when the repo names no CI workflow", () => {
    const wiring = Events.workflowOn(repoFlows, { ciWorkflows: ["chernabog"], own: "chernabog" });

    expect(wiring.on.workflow_run).toBeUndefined();
    expect(wiring.routes.some((route) => route.event === "workflow_run")).toBe(false);
    expect(wiring.notes).toEqual([
      "address-review wakes on workflow_run, but the repo names no CI workflow to filter it to, so it waits for the schedule",
      "implement wakes on workflow_run, but the repo names no CI workflow to filter it to, so it waits for the schedule",
      "review wakes on workflow_run, but the repo names no CI workflow to filter it to, so it waits for the schedule",
    ]);
  });

  test("wakes on phase events only when a flow's sources read phases", () => {
    const wiring = Events.workflowOn([ciFlow("resolve-conflicts", NO_PARK_DOCUMENT)], {
      ciWorkflows: ["CI"],
    });

    expect(wiring.on).toEqual({ pull_request: { types: ["closed"] } });
    expect(wiring.routes.map((route) => route.item)).toEqual([{ kind: "repo" }]);
  });

  test("is empty for no flows", () => {
    expect(Events.workflowOn([], { ciWorkflows: ["CI"] })).toEqual({
      on: {},
      routes: [],
      notes: [],
    });
  });
});

describe("from an event to the items it concerns", () => {
  const { routes } = Events.workflowOn(repoFlows, { ciWorkflows: ["CI"], own: "chernabog" });

  test("a label wakes the flows that read it, on the issue it names", () => {
    expect(
      Events.wokenBy(routes, "issues", {
        action: "labeled",
        issue: { number: 7 },
        sender: { login: "maintainer" },
      }),
    ).toEqual([
      { flow: "implement", persona: "bot", item: { kind: "issue", number: 7 } },
      { flow: "plan", persona: "bot", item: { kind: "issue", number: 7 } },
    ]);
  });

  test("a type no flow declares wakes nothing", () => {
    expect(Events.wokenBy(routes, "issues", { action: "opened", issue: { number: 7 } })).toEqual(
      [],
    );
    expect(Events.wokenBy(routes, "check_suite", { action: "completed" })).toEqual([]);
  });

  test("an event the flow's own persona caused doesn't wake it", () => {
    expect(
      Events.wokenBy(routes, "pull_request", {
        action: "review_requested",
        pull_request: { number: 12, author_association: "MEMBER" },
        sender: { login: "Reviewer-A" },
      }),
    ).toEqual([
      { flow: "review", persona: "reviewer-b", item: { kind: "pull-request", number: 12 } },
    ]);
  });

  test("an event caused by someone the repo doesn't trust wakes nothing", () => {
    const review = (association: string) =>
      Events.wokenBy(routes, "pull_request_review", {
        action: "submitted",
        review: { author_association: association },
        pull_request: { number: 12 },
        sender: { login: "someone" },
      });

    expect(review("NONE")).toEqual([]);
    expect(review("CONTRIBUTOR")).toEqual([]);
    expect(review("COLLABORATOR")).toEqual([
      { flow: "address-review", persona: "bot", item: { kind: "pull-request", number: 12 } },
    ]);
    expect(
      Events.wokenBy(routes, "issue_comment", {
        action: "created",
        issue: { number: 3 },
        comment: {},
      }),
    ).toEqual([]);
  });

  test("a CI run that finished wakes on its branch, the persona's own push's too", () => {
    expect(
      Events.wokenBy(routes, "workflow_run", {
        action: "completed",
        workflow_run: { head_branch: "main" },
        sender: { login: "reviewer-a" },
      }),
    ).toEqual([
      // implement and address-review take up a wait for CI they parked on.
      { flow: "implement", persona: "bot", item: { kind: "branch", name: "main" } },
      { flow: "review", persona: "reviewer-a", item: { kind: "branch", name: "main" } },
      { flow: "review", persona: "reviewer-b", item: { kind: "branch", name: "main" } },
      { flow: "address-review", persona: "bot", item: { kind: "branch", name: "main" } },
    ]);
  });

  test("a phase event wakes every flow whose sources read phases, on its item", () => {
    expect(
      Events.wokenBy(routes, "repository_dispatch", {
        action: "chernabog-phase",
        client_payload: { item: "pr-12", phase: "changes-asked" },
        sender: { login: "bot" },
      }),
    ).toEqual(
      ["implement", "review", "review", "address-review", "plan"].map((flow, index) => ({
        flow,
        persona: ["bot", "reviewer-a", "reviewer-b", "bot", "bot"][index] ?? "",
        item: { kind: "item", name: "pr-12" },
      })),
    );
  });

  test("a payload that doesn't name the item where the declaration says wakes nothing", () => {
    expect(Events.wokenBy(routes, "issues", { action: "labeled", issue: { number: "7" } })).toEqual(
      [],
    );
  });

  test("a CI run whose payload names no head branch wakes nothing on its branch", () => {
    expect(
      Events.wokenBy(routes, "workflow_run", {
        action: "completed",
        workflow_run: { head_branch: "" },
        sender: { login: "maintainer" },
      }),
    ).toEqual([]);
  });
});

// Routes for one flow, run as `bot`, that declares just these events.
const routesOf = (events: ReadonlyArray<Events.WakingEvent>) =>
  Events.workflowOn(
    [{ flow: "flow", personas: ["bot"], declared: { events, readsPhases: false } }],
    {
      ciWorkflows: ["CI"],
    },
  ).routes;

describe("each declaration's guards", () => {
  const pullRequestBy = (action: string, association: string) => ({
    action,
    pull_request: { number: 12, author_association: association },
    sender: { login: "someone" },
  });

  const woken: ReadonlyArray<Events.Woken> = [
    { flow: "flow", persona: "bot", item: { kind: "pull-request", number: 12 } },
  ];

  test("a review asked, or asked again, wakes only for a pull request whose author the repo trusts", () => {
    for (const declared of [Events.reviewRequested, Events.reviewRequestedAgain]) {
      const routes = routesOf([declared]);

      expect(
        Events.wokenBy(routes, "pull_request", pullRequestBy("review_requested", "MEMBER")),
      ).toEqual(woken);
      expect(
        Events.wokenBy(routes, "pull_request", pullRequestBy("review_requested", "NONE")),
      ).toEqual([]);
    }
  });

  test("a draft marked ready wakes only when the repo trusts its author", () => {
    const routes = routesOf([Events.readyForReview]);

    expect(
      Events.wokenBy(routes, "pull_request", pullRequestBy("ready_for_review", "OWNER")),
    ).toEqual(woken);
    expect(
      Events.wokenBy(routes, "pull_request", pullRequestBy("ready_for_review", "CONTRIBUTOR")),
    ).toEqual([]);
  });

  test("a comment wakes only when the repo trusts its author", () => {
    const routes = routesOf([Events.commentCreated]);

    const comment = (association: string) =>
      Events.wokenBy(routes, "issue_comment", {
        action: "created",
        issue: { number: 3 },
        comment: { author_association: association },
        sender: { login: "someone" },
      });

    expect(comment("COLLABORATOR")).toEqual([
      { flow: "flow", persona: "bot", item: { kind: "issue", number: 3 } },
    ]);
    expect(comment("NONE")).toEqual([]);
  });

  test("the persona's own merge wakes what waits on a pull request closing", () => {
    expect(
      Events.wokenBy(routesOf([Events.pullRequestClosed]), "pull_request", {
        action: "closed",
        pull_request: { number: 12 },
        sender: { login: "bot" },
      }),
    ).toEqual(woken);
  });

  test("a merge wakes what it may have moved the base under on every item, and an issue closed doesn't", () => {
    const routes = routesOf([Events.baseMoved]);

    expect(
      Events.wokenBy(routes, "pull_request", {
        action: "closed",
        pull_request: { number: 12 },
        sender: { login: "maintainer" },
      }),
    ).toEqual([{ flow: "flow", persona: "bot", item: { kind: "repo" } }]);
    expect(
      Events.wokenBy(routes, "issues", {
        action: "closed",
        issue: { number: 3 },
        sender: { login: "maintainer" },
      }),
    ).toEqual([]);
  });

  test("a merge commit's CI is a push's on the default branch, never a pull request's from a branch of that name", () => {
    const routes = routesOf([Events.mergeCiCompleted]);

    const run = (event: string) =>
      Events.wokenBy(routes, "workflow_run", {
        action: "completed",
        workflow_run: { event, head_branch: "main", head_sha: "c0ffee", pull_requests: [] },
        repository: { default_branch: "main" },
        sender: { login: "maintainer" },
      });

    expect(run("push")).toEqual([
      { flow: "flow", persona: "bot", item: { kind: "ci-run", sha: "c0ffee", pullRequests: [] } },
    ]);
    expect(run("pull_request")).toEqual([]);
  });
});

describe("what a finished CI run settles", () => {
  const run = { sha: "c0ffee", pullRequests: [7, 8] };

  test("a record naming one of its pull requests among others it waits on", () => {
    expect(
      Events.parkedOn(
        [
          ["epic-4", { tasks: { ci: [{ pullRequest: 3 }, { pullRequest: 8 }] } }],
          ["epic-5", { tasks: { ci: [] } }],
        ],
        run,
      ),
    ).toEqual(["epic-4"]);
  });

  test("a number that isn't a pull request's, though it equals one, names nothing", () => {
    expect(Events.parkedOn([["issue-7", { issue: 7, round: 8 }]], run)).toEqual([]);
  });
});
