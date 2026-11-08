import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunNodeEntity } from "./run-node.entity.ts";

// The marks runs left at the nodes of their plans: `insertOne` adds one,
// `updateOne` records how a run left the node a mark is at, and `findMany`
// reads those a spec (RunNodeSpecifications) holds of, in the order they
// were made.
export type RunNodesRepositoryService = {
  readonly findMany: (
    spec: Specification<RunNodeEntity>,
  ) => Effect.Effect<ReadonlyArray<RunNodeEntity>>;
  readonly insertOne: (mark: RunNodeEntity) => Effect.Effect<void>;
  readonly updateOne: (mark: RunNodeEntity) => Effect.Effect<void>;
};

export class RunNodesRepository extends Context.Service<
  RunNodesRepository,
  RunNodesRepositoryService
>()("RunNodesRepository") {}
