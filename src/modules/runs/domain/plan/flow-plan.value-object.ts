import * as Schema from "effect/Schema";

// A flow's plan: the tree of the flow document it was compiled from, as data,
// which a run is drawn on. The SDK's compiler builds it (Compose.plan) and
// the generated flow file carries it; a flow written in TypeScript has none.
//
// Each node has its step's id, or for a step with none (an end, a next, an
// if) its path in the document, which it also carries
// (`steps[2].on.approve.steps[0]`), and says what it is: the block or stage
// a step runs and its wiring, with its outcome branches by outcome; how an
// end ends; a repeat's state and body; what a next carries to the next round;
// a forEach's items, what it names each, its scope and its lane's steps; an
// if's condition, over the step it runs; and what a first chooses between.

type Wiring = { readonly [input: string]: Schema.Json };

export type PlanBranch = {
  readonly outcome: string;
  readonly as?: string;
  readonly steps: ReadonlyArray<PlanNode>;
};

type Branched = {
  readonly in: Wiring;
  readonly with: Wiring;
  readonly branches: ReadonlyArray<PlanBranch>;
};

type NodeOf<Kind extends string, Fields> = {
  readonly id: string;
  readonly path: string;
  readonly kind: Kind;
} & Fields;

export type PlanNode =
  | NodeOf<"use", { readonly block: string } & Branched>
  | NodeOf<"stage", { readonly stage: string } & Branched>
  | NodeOf<"end", { readonly end: "done"; readonly summary?: string }>
  | NodeOf<"end", { readonly end: "needs-human"; readonly reason: string }>
  | NodeOf<"repeat", { readonly state: Wiring; readonly steps: ReadonlyArray<PlanNode> }>
  | NodeOf<"next", { readonly next: Wiring }>
  | NodeOf<
      "forEach",
      {
        readonly forEach: string;
        readonly as: string;
        readonly scope: string;
        readonly atOnce: string;
        readonly steps: ReadonlyArray<PlanNode>;
      }
    >
  | NodeOf<"if", { readonly condition: string; readonly steps: ReadonlyArray<PlanNode> }>
  | NodeOf<"first", { readonly first: ReadonlyArray<string> }>;

const Wiring = Schema.Record(Schema.String, Schema.Json);

const Nodes = Schema.Array(Schema.suspend((): Schema.Codec<PlanNode> => PlanNode));

const PlanBranch = Schema.Struct({
  outcome: Schema.String,
  as: Schema.optionalKey(Schema.String),
  steps: Nodes,
});

const node = <Kind extends string>(kind: Kind) => ({
  id: Schema.String,
  path: Schema.String,
  kind: Schema.Literal(kind),
});

const branched = { in: Wiring, with: Wiring, branches: Schema.Array(PlanBranch) };

export const PlanNode: Schema.Codec<PlanNode> = Schema.Union([
  Schema.Struct({ ...node("use"), block: Schema.String, ...branched }),
  Schema.Struct({ ...node("stage"), stage: Schema.String, ...branched }),
  Schema.Struct({
    ...node("end"),
    end: Schema.Literal("done"),
    summary: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ ...node("end"), end: Schema.Literal("needs-human"), reason: Schema.String }),
  Schema.Struct({ ...node("repeat"), state: Wiring, steps: Nodes }),
  Schema.Struct({ ...node("next"), next: Wiring }),
  Schema.Struct({
    ...node("forEach"),
    forEach: Schema.String,
    as: Schema.String,
    scope: Schema.String,
    atOnce: Schema.String,
    steps: Nodes,
  }),
  Schema.Struct({ ...node("if"), condition: Schema.String, steps: Nodes }),
  Schema.Struct({ ...node("first"), first: Schema.Array(Schema.String) }),
]);

// A flow's plan, and the hash of its content, which two compiles of one
// document share, so runs of the same plan can share one copy of it.
export class FlowPlan extends Schema.Class<FlowPlan, { readonly brand: "FlowPlan" }>("FlowPlan")({
  flow: Schema.String,
  subject: Schema.String,
  hash: Schema.String,
  steps: Nodes,
}) {}

// A plan by its hash, if a run started with it.
export class FoundPlan extends Schema.Class<FoundPlan, { readonly brand: "FoundPlan" }>(
  "FoundPlan",
)({
  plan: Schema.Option(FlowPlan),
}) {}
