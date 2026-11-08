import type * as Option from "effect/Option";

import type { FlowPlan, PlanNode } from "#daemon/protocol";

import type { NodeStates } from "./plan-graph.ts";

export const PlanCanvas = (_props: {
  readonly plan: FlowPlan;
  readonly states: Option.Option<NodeStates>;
  readonly chosen: Option.Option<string>;
  readonly onChoose: (id: string) => void;
}) => <div />;

export const PlanNodeDetail = (_props: { readonly node: PlanNode }) => <div />;
