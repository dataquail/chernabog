// A flow document's plan: its tree as data, which a run is drawn on. The SDK
// builds it as the generated flow file exports it, and the runs module decodes
// it with a schema of its own, as the daemon and the browser read it.

import { Compose } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { FlowPlan, type PlanNode } from "../src/modules/runs/domain/plan/flow-plan.value-object.ts";
import { planOf } from "../src/modules/runs/infrastructure/runtime/flow-registry.ts";
import { flowPlanOf } from "../src/platform/flow-loader.ts";
import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  DRAFT_DOCUMENT,
  EPIC_DOCUMENT,
  generated,
  HUMAN_INITIATED_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  IMPLEMENT_READY_DOCUMENT,
  loadFlow,
  loadModule,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  READY_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
  REVIEW_WITH_STAGE_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";

const DOCUMENTS = {
  implement: IMPLEMENT_DOCUMENT,
  draft: DRAFT_DOCUMENT,
  ready: READY_DOCUMENT,
  implementReady: IMPLEMENT_READY_DOCUMENT,
  review: REVIEW_DOCUMENT,
  reReview: RE_REVIEW_DOCUMENT,
  addressReview: ADDRESS_REVIEW_DOCUMENT,
  resolveConflicts: RESOLVE_CONFLICTS_DOCUMENT,
  postMerge: POST_MERGE_DOCUMENT,
  humanInitiated: HUMAN_INITIATED_DOCUMENT,
  plan: PLAN_DOCUMENT,
  epic: EPIC_DOCUMENT,
  reviewWithStage: REVIEW_WITH_STAGE_DOCUMENT,
};

const decodePlan = Schema.decodeUnknownSync(FlowPlan);

// A document's plan as the daemon decodes it.
const planFor = (source: string) => decodePlan(Compose.plan(documentOf(source)));

const childrenOf = (node: PlanNode): ReadonlyArray<PlanNode> => {
  if (node.kind === "use" || node.kind === "stage") {
    return node.branches.flatMap((branch) => branch.steps);
  }

  if (node.kind === "repeat" || node.kind === "forEach" || node.kind === "if") {
    return node.steps;
  }

  return [];
};

const everyNode = (nodes: ReadonlyArray<PlanNode>): ReadonlyArray<PlanNode> =>
  nodes.flatMap((node) => [node, ...everyNode(childrenOf(node))]);

const nodeAt = (plan: FlowPlan, path: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(everyNode(plan.steps).find((node) => node.path === path)),
  );

// What a block does, as the SDK describes it to a person composing a document.
const aboutOf = (block: string) => {
  const described = Schema.decodeUnknownSync(
    Schema.Struct({
      blocks: Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String })),
    }),
  )(Compose.describe());

  return Option.getOrThrow(
    Option.fromUndefinedOr(described.blocks.find((each) => each.name === block)),
  ).about;
};

describe("a flow document's plan", () => {
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    test(`decodes for the ${name} document, every node with an id of its own`, () => {
      const plan = planFor(source);
      const ids = everyNode(plan.steps).map((node) => node.id);

      expect(plan.flow).toBe(documentOf(source).flow);
      expect(plan.steps.length).toBe(documentOf(source).steps.length);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  test("labels a block's outcome branches by outcome, each with its steps, and names an end by its path", () => {
    const plan = planFor(IMPLEMENT_DOCUMENT);

    expect(nodeAt(plan, "steps[0]")).toEqual({
      id: "claim",
      path: "steps[0]",
      kind: "use",
      block: "issue.claim",
      about: aboutOf("issue.claim"),
      in: { issue: "trigger.issue", queued: "trigger.queued" },
      with: { adopt: true },
      branches: [
        {
          outcome: "adopted",
          as: "adopted",
          steps: [
            expect.objectContaining({ id: "ready", path: "steps[0].on.adopted.steps[0]" }),
            expect.objectContaining({ id: "adoptedCi", path: "steps[0].on.adopted.steps[1]" }),
            expect.objectContaining({ id: "handedOver", path: "steps[0].on.adopted.steps[2]" }),
            {
              id: "steps[0].on.adopted.steps[3]",
              path: "steps[0].on.adopted.steps[3]",
              kind: "end",
              end: "done",
              summary: "handedOver",
            },
          ],
        },
      ],
    });

    expect(nodeAt(plan, "steps[2].on.needs-clarification.steps[1]")).toEqual({
      id: "steps[2].on.needs-clarification.steps[1]",
      path: "steps[2].on.needs-clarification.steps[1]",
      kind: "end",
      end: "needs-human",
      reason: "asked",
    });

    const lane = "steps[3].repeat.steps[8].steps[2].on.needs-clarification.steps[2]";

    expect(nodeAt(planFor(EPIC_DOCUMENT), lane)).toEqual({
      id: lane,
      path: lane,
      kind: "end",
      end: "done",
    });
  });

  test("gives each block step what its block does, for a person reading the plan", () => {
    for (const source of Object.values(DOCUMENTS)) {
      for (const node of everyNode(planFor(source).steps)) {
        if (node.kind === "use") {
          expect(node.about).toBe(aboutOf(node.block));
          expect(node.about).not.toBe("");
        }
      }
    }
  });

  test("gives a repeat its state and its body, and a next what it carries", () => {
    const plan = planFor(EPIC_DOCUMENT);
    const rounds = nodeAt(plan, "steps[3]");

    expect(rounds).toMatchObject({
      id: "rounds",
      kind: "repeat",
      state: { tasks: "epic.tasks", stack: "stack.upkeep" },
    });

    expect(childrenOf(rounds).map((node) => [node.id, node.kind])).toEqual([
      ["progress", "use"],
      ["status", "use"],
      ["noted", "use"],
      ["closed", "use"],
      ["carried", "use"],
      ["steps[3].repeat.steps[5].if", "if"],
      ["latest", "first"],
      ["ready", "use"],
      ["started", "forEach"],
      ["recorded", "use"],
      ["steps[3].repeat.steps[10]", "next"],
    ]);

    expect(nodeAt(plan, "steps[3].repeat.steps[10]")).toEqual({
      id: "steps[3].repeat.steps[10]",
      path: "steps[3].repeat.steps[10]",
      kind: "next",
      next: { tasks: "recorded.tasks", stack: "latest.stack" },
    });

    expect(nodeAt(plan, "steps[3].repeat.steps[6]")).toEqual({
      id: "latest",
      path: "steps[3].repeat.steps[6]",
      kind: "first",
      first: ["landed", "carried"],
    });
  });

  test("gives a forEach its items, what it names each, its scope and its lane's steps", () => {
    const started = nodeAt(planFor(EPIC_DOCUMENT), "steps[3].repeat.steps[8]");

    expect(started).toMatchObject({
      id: "started",
      kind: "forEach",
      forEach: "ready.starts",
      as: "task",
      scope: "epic.task",
      atOnce: "howMany.value",
    });

    expect(childrenOf(started).map((node) => [node.id, node.path])).toEqual([
      ["claim", "steps[3].repeat.steps[8].steps[0]"],
      ["worktree", "steps[3].repeat.steps[8].steps[1]"],
      ["agent", "steps[3].repeat.steps[8].steps[2]"],
      ["gate", "steps[3].repeat.steps[8].steps[3]"],
      ["published", "steps[3].repeat.steps[8].steps[4]"],
      ["ci", "steps[3].repeat.steps[8].steps[5]"],
      ["done", "steps[3].repeat.steps[8].steps[6]"],
    ]);
  });

  test("puts a conditional step under an if, which names what it runs on", () => {
    const plan = planFor(EPIC_DOCUMENT);

    expect(nodeAt(plan, "steps[3].repeat.steps[5].if")).toEqual({
      id: "steps[3].repeat.steps[5].if",
      path: "steps[3].repeat.steps[5].if",
      kind: "if",
      condition: "ships.value",
      steps: [
        {
          id: "landed",
          path: "steps[3].repeat.steps[5]",
          kind: "use",
          block: "stack.land",
          about: aboutOf("stack.land"),
          in: { round: "round", progress: "progress", stack: "carried.stack" },
          with: {},
          branches: [
            {
              outcome: "moved",
              as: "moved",
              steps: [
                {
                  id: "steps[3].repeat.steps[5].on.moved.steps[0]",
                  path: "steps[3].repeat.steps[5].on.moved.steps[0]",
                  kind: "next",
                  next: { tasks: "noted.tasks", stack: "moved" },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("names a stage step's stage and wiring", () => {
    expect(nodeAt(planFor(REVIEW_WITH_STAGE_DOCUMENT), "steps[0]")).toEqual({
      id: "which",
      path: "steps[0]",
      kind: "stage",
      stage: "which-pr",
      in: { pr: "trigger.pr" },
      with: {},
      branches: [],
    });
  });

  test("hashes its content: a recompile gives the same hash, and a change another", () => {
    const first = Compose.plan(documentOf(EPIC_DOCUMENT));
    const again = Compose.plan(documentOf(EPIC_DOCUMENT));

    const changed = Compose.plan(
      documentOf(EPIC_DOCUMENT.replace("lookAgainAfter: 1 day", "lookAgainAfter: 2 days")),
    );

    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(again.hash).toBe(first.hash);
    expect(changed.hash).not.toBe(first.hash);
    expect(Compose.plan(documentOf(REVIEW_DOCUMENT)).hash).not.toBe(first.hash);
  });
});

describe("a generated flow's plan", () => {
  effect(
    "is exported beside its default, which carries it, as the loader and registry read it",
    () =>
      Effect.gen(function* () {
        const document = documentOf(REVIEW_DOCUMENT);
        const module = yield* loadModule(generated(document));
        const expected = Compose.plan(document);

        expect(module.plan).toEqual(expected);
        expect(flowPlanOf(module.default)).toEqual(Option.some(expected));
        expect(Option.map(planOf(module.default), (plan) => plan.hash)).toEqual(
          Option.some(expected.hash),
        );
      }),
  );

  effect("is the same however often the document compiles", () =>
    Effect.gen(function* () {
      const flow = yield* loadFlow(documentOf(EPIC_DOCUMENT));

      expect(Option.map(planOf(flow), (plan) => plan.hash)).toEqual(
        Option.some(Compose.plan(documentOf(EPIC_DOCUMENT)).hash),
      );
    }),
  );
});
