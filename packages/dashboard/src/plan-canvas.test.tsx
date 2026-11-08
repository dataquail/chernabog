// A flow's plan on the canvas: the review, implement and epic documents'
// plans drawn as their nodes, the outcomes on their branches and the frames
// of their repeats and forEaches; the arrows between them, worked out by
// walking the plan; a run's node states on them; a node's detail; and the
// flows page's plan of a flow, or its note that the flow has none.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DaemonStatus,
  FlowPlan,
  type NodeState,
  type PlanNode,
  RunHistory,
  RunOnPlan,
} from "#daemon/protocol";

import { DOCUMENT_PLANS } from "./document-plans.ts";
import { FlowPlanSection } from "./flows.tsx";
import { PlanCanvas, PlanNodeDetail } from "./plan-canvas.tsx";
import { nodeById, nodeStates, outcomeNode, type PlanEdge, planEdges } from "./plan-graph.ts";

// The documents' plans as Compose.plan compiles them (test/dashboard-plans.test.ts
// holds the file to it), as the page decodes a flow's.
const REVIEW = Schema.decodeUnknownSync(FlowPlan)(DOCUMENT_PLANS.review);
const IMPLEMENT = Schema.decodeUnknownSync(FlowPlan)(DOCUMENT_PLANS.implement);
const EPIC = Schema.decodeUnknownSync(FlowPlan)(DOCUMENT_PLANS.epic);

const canvas = (plan: FlowPlan, states = Option.none<ReadonlyMap<string, NodeState>>()) =>
  renderToStaticMarkup(
    <PlanCanvas plan={plan} states={states} chosen={Option.none()} onChoose={() => {}} />,
  );

const unescaped = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

// Every element the canvas drew for a node, in order, by the id it carries.
const nodesIn = (markup: string) =>
  [...markup.matchAll(/data-node="([^"]*)"/g)].map((found) => unescaped(found[1]));

// An element's opening tag, by the node it's for.
const tagOf = (markup: string, id: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...markup.matchAll(/<[a-z]+ [^>]*data-node="([^"]*)"[^>]*>/g)].find(
        (found) => unescaped(found[1]) === id,
      ),
    ),
  )[0];

type UseNode = Extract<PlanNode, { readonly kind: "use" }>;

const isUse = (node: PlanNode): node is UseNode => node.kind === "use";

const edge = (from: string, to: string, kind: PlanEdge["kind"]): PlanEdge => ({ from, to, kind });

describe("the canvas draws a document's plan", () => {
  test("the review document: its block, a fork with an outcome on each arrow, and an end on each branch", () => {
    const markup = canvas(REVIEW);

    expect(nodesIn(markup)).toEqual([
      "review",
      outcomeNode("review", "approve"),
      "land",
      "steps[0].on.approve.steps[1]",
      outcomeNode("review", "changes"),
      "steps[0].on.changes.steps[0]",
    ]);
    expect(tagOf(markup, outcomeNode("review", "approve"))).toContain('class="plan-outcome"');
    expect(markup).toContain(">approve</span>");
    expect(markup).toContain(">changes</span>");
    expect(tagOf(markup, "steps[0].on.approve.steps[1]")).toContain('data-end="done"');
    expect(markup).not.toContain("plan-frame");
  });

  test("the implement document: a chain of blocks, forks that end in done and needs-human", () => {
    const markup = canvas(IMPLEMENT);
    const nodes = nodesIn(markup);

    expect(nodes.slice(0, 7)).toEqual([
      "claim",
      outcomeNode("claim", "adopted"),
      "ready",
      "adoptedCi",
      "handedOver",
      "steps[0].on.adopted.steps[3]",
      "worktree",
    ]);
    expect(nodes).toContain(outcomeNode("agent", "needs-clarification"));
    expect(markup).toContain(">needs-clarification</span>");
    expect(tagOf(markup, "steps[2].on.needs-clarification.steps[1]")).toContain(
      'data-end="needs-human"',
    );
    expect(nodes.slice(-6)).toEqual(["gate", "push", "opened", "ci", "done", "steps[8]"]);
    expect(tagOf(markup, "steps[8]")).toContain('data-end="done"');
  });

  test("the epic document: a repeat's frame with its arrow back, an if's frame, and a forEach's frame with a template lane", () => {
    const markup = canvas(EPIC);

    expect(tagOf(markup, "rounds")).toContain('class="plan-frame repeat"');
    expect(markup).toContain('aria-label="back to the start of rounds"');
    expect(tagOf(markup, "steps[3].repeat.steps[5].if")).toContain('class="plan-frame if"');
    expect(markup).toContain("ships.value");
    expect(tagOf(markup, "started")).toContain('class="plan-frame forEach"');
    expect(markup).toContain('aria-label="template lane"');
    expect(markup).toContain("ready.starts");

    const nodes = nodesIn(markup);
    const lane = nodes.slice(nodes.indexOf("started") + 1, nodes.indexOf("recorded"));

    expect(lane).toEqual([
      "claim",
      "worktree",
      "agent",
      outcomeNode("agent", "needs-clarification"),
      "asked",
      "released",
      "steps[3].repeat.steps[8].steps[2].on.needs-clarification.steps[2]",
      "gate",
      "published",
      "ci",
      "done",
    ]);
    expect(nodes.slice(0, 4)).toEqual(["claimed", "ships", "howMany", "rounds"]);
  });

  test("a run's node states mark its nodes; without them, none is marked", () => {
    const states = new Map<string, NodeState>([
      ["review", "ok"],
      ["land", "running"],
      ["steps[0].on.changes.steps[0]", "not-taken"],
    ]);

    const markup = canvas(REVIEW, Option.some(states));

    expect(tagOf(markup, "review")).toContain("state-ok");
    expect(tagOf(markup, "land")).toContain("state-running");
    expect(tagOf(markup, "steps[0].on.changes.steps[0]")).toContain("state-not-taken");
    expect(canvas(REVIEW)).not.toContain("state-");
  });
});

describe("the arrows, worked out by walking the plan", () => {
  test("a fork: an arrow to each outcome, and on from it to its branch", () => {
    expect(planEdges(REVIEW.steps)).toEqual([
      edge("review", outcomeNode("review", "approve"), "branch"),
      edge(outcomeNode("review", "approve"), "land", "next"),
      edge("land", "steps[0].on.approve.steps[1]", "next"),
      edge("review", outcomeNode("review", "changes"), "branch"),
      edge(outcomeNode("review", "changes"), "steps[0].on.changes.steps[0]", "next"),
    ]);
  });

  test("a chain goes on past a fork whose branches end, and no arrow leaves an end", () => {
    const edges = planEdges(IMPLEMENT.steps);

    expect(edges).toContainEqual(edge("claim", "worktree", "next"));
    expect(edges).toContainEqual(edge("agent", "gate", "next"));
    expect(edges).toContainEqual(edge("ci", "done", "next"));
    expect(edges).toContainEqual(edge("done", "steps[8]", "next"));
    expect(edges.filter((each) => each.from === "steps[0].on.adopted.steps[3]")).toEqual([]);
    expect(edges.filter((each) => each.from === "steps[8]")).toEqual([]);
  });

  test("a branch that doesn't end rejoins the chain after its fork", () => {
    const plan = Schema.decodeSync(FlowPlan)({
      flow: "demo",
      subject: "issue",
      hash: "hash",
      steps: [
        {
          id: "look",
          path: "steps[0]",
          kind: "use",
          block: "demo.look",
          in: {},
          with: {},
          branches: [
            {
              outcome: "odd",
              steps: [
                {
                  id: "fix",
                  path: "steps[0].on.odd.steps[0]",
                  kind: "use",
                  block: "demo.fix",
                  in: {},
                  with: {},
                  branches: [],
                },
              ],
            },
          ],
        },
        {
          id: "after",
          path: "steps[1]",
          kind: "use",
          block: "demo.after",
          in: {},
          with: {},
          branches: [],
        },
      ],
    });

    expect(planEdges(plan.steps)).toEqual([
      edge("look", outcomeNode("look", "odd"), "branch"),
      edge(outcomeNode("look", "odd"), "fix", "next"),
      edge("look", "after", "next"),
      edge("fix", "after", "next"),
    ]);
  });

  test("a repeat loops back to its start, from itself and from each next in it", () => {
    const loops = planEdges(EPIC.steps).filter((each) => each.kind === "loop");

    expect(loops).toEqual([
      edge("steps[3].repeat.steps[4].on.moved.steps[0]", "rounds", "loop"),
      edge("steps[3].repeat.steps[5].on.moved.steps[0]", "rounds", "loop"),
      edge("steps[3].repeat.steps[7].on.none.steps[1]", "rounds", "loop"),
      edge("steps[3].repeat.steps[10]", "rounds", "loop"),
      edge("rounds", "rounds", "loop"),
    ]);
  });

  test("a frame is one box in its chain: in from the step before, on to the step after", () => {
    const edges = planEdges(EPIC.steps);

    expect(edges).toContainEqual(edge("howMany", "rounds", "next"));
    expect(edges).toContainEqual(edge("ready", "started", "next"));
    expect(edges).toContainEqual(edge("started", "recorded", "next"));
    expect(edges).toContainEqual(edge("claim", "worktree", "next"));
  });
});

describe("a run's states, from the runs module's model", () => {
  test("give each node its state by its id", () => {
    const history = Schema.decodeSync(RunHistory)({
      steps: [],
      waits: [],
      plan: REVIEW.hash,
      nodes: [
        {
          node: { id: "review" },
          enteredAt: "2026-11-08T14:00:00.000Z",
          finishedAt: "2026-11-08T14:00:01.000Z",
          outcome: "ok",
        },
        { node: { id: "land" }, enteredAt: "2026-11-08T14:00:02.000Z" },
      ],
      branches: [
        { node: { id: "review" }, outcome: "approve", takenAt: "2026-11-08T14:00:01.000Z" },
      ],
      ends: [],
    });

    const states = nodeStates(RunOnPlan.draw(REVIEW, history, { status: "running" }));

    expect(states.get("review")).toBe("ok");
    expect(states.get("land")).toBe("running");
    expect(states.get("steps[0].on.approve.steps[1]")).toBe("not-reached");
    expect(states.get("steps[0].on.changes.steps[0]")).toBe("not-taken");
  });
});

describe("a node's detail", () => {
  test("a block step: its block, what the block does, and where each input comes from", () => {
    const land = Option.getOrThrow(Option.filter(nodeById(REVIEW.steps, "land"), isUse));
    const markup = renderToStaticMarkup(<PlanNodeDetail node={land} />);

    expect(markup).toContain("pr.land");
    expect(land.about).toBeString();
    expect(unescaped(markup)).toContain(Option.getOrThrow(Option.fromUndefinedOr(land.about)));
    expect(markup).toMatch(/<th>pr<\/th><td>in<\/td><td><code>trigger.pr<\/code><\/td>/);
    expect(markup).toMatch(
      /<th>approved<\/th><td>in<\/td><td><code>verdict.approved<\/code><\/td>/,
    );
    expect(markup).toMatch(/<th>method<\/th><td>with<\/td><td><code>squash<\/code><\/td>/);
  });

  test("an end says how it ends", () => {
    const end = Option.getOrThrow(
      nodeById(IMPLEMENT.steps, "steps[2].on.needs-clarification.steps[1]"),
    );

    expect(renderToStaticMarkup(<PlanNodeDetail node={end} />)).toContain("needs-human");
  });

  test("a node the plan doesn't have is none", () => {
    expect(nodeById(REVIEW.steps, "nowhere")).toEqual(Option.none());
  });
});

const FlowStatus = DaemonStatus.fields.repos.value.fields.flows.value;

const flowStatus = (plan: Option.Option<FlowPlan>) =>
  FlowStatus.make({
    name: "review",
    schedule: "*/5 * * * *",
    next: Option.none(),
    lastTick: Option.none(),
    enabled: true,
    queued: [],
    ...Option.match(plan, { onNone: () => ({}), onSome: (some) => ({ plan: some }) }),
  });

describe("the flows page's plan of a flow", () => {
  test("a flow compiled from a document shows its plan", () => {
    const markup = renderToStaticMarkup(
      <FlowPlanSection flow={flowStatus(Option.some(REVIEW))} repo="api" />,
    );

    expect(markup).toContain('class="plan-canvas"');
    expect(nodesIn(markup)).toContain("land");
    expect(markup).not.toContain("written in TypeScript");
  });

  test("a flow with no plan says it was written in TypeScript", () => {
    const markup = renderToStaticMarkup(
      <FlowPlanSection flow={flowStatus(Option.none())} repo="api" />,
    );

    expect(markup).toContain("written in TypeScript");
    expect(markup).not.toContain("plan-canvas");
  });
});
