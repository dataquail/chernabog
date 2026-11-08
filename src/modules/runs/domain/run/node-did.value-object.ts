import * as Schema from "effect/Schema";

import { StepOutcome } from "./step-outcome.value-object.ts";

// What a run did at a node of its plan (core's PlanNodes), as its flow
// reports it: entered it, left it with how, took its block's branch for an
// outcome, or reached the end it is.
export const NodeEntered = Schema.TaggedStruct("NodeEntered", {});

export const NodeFinished = Schema.TaggedStruct("NodeFinished", { outcome: StepOutcome });

export const BranchTaken = Schema.TaggedStruct("BranchTaken", { outcome: Schema.String });

export const EndReached = Schema.TaggedStruct("EndReached", {});

export const NodeDid = Schema.Union([NodeEntered, NodeFinished, BranchTaken, EndReached]);

export type NodeDid = typeof NodeDid.Type;
