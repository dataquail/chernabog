import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunLaneEntity } from "./run-lane.entity.ts";

// The lanes runs declared: `upsertOne` keeps a run's lane as given, replacing
// what it held, and `findMany` reads those a spec (RunLaneSpecifications)
// holds of, in the order they were first declared.
export type RunLanesRepositoryService = {
  readonly findMany: (
    spec: Specification<RunLaneEntity>,
  ) => Effect.Effect<ReadonlyArray<RunLaneEntity>>;
  readonly upsertOne: (lane: RunLaneEntity) => Effect.Effect<void>;
};

export class RunLanesRepository extends Context.Service<
  RunLanesRepository,
  RunLanesRepositoryService
>()("RunLanesRepository") {}
