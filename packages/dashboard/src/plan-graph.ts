import * as Option from "effect/Option";

import type { NodeState, PlanNode, RunOnPlan } from "#daemon/protocol";

export type PlanEdge = {
  readonly from: string;
  readonly to: string;
  readonly kind: "next" | "branch" | "loop";
};

export type NodeStates = ReadonlyMap<string, NodeState>;

export const outcomeNode = (node: string, outcome: string) => `${node}:${outcome}`;

export const planEdges = (_steps: ReadonlyArray<PlanNode>): ReadonlyArray<PlanEdge> => [];

export const nodeById = (_steps: ReadonlyArray<PlanNode>, _id: string): Option.Option<PlanNode> =>
  Option.none();

export const nodeStates = (_run: RunOnPlan): NodeStates => new Map();
