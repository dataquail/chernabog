import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunWaitRoot } from "./run-wait.root.ts";

// The waits runs are parked on, read by a spec (RunWaitSpecifications). A wait
// is one run's deferred, so upserting one replaces the run's wait on the same
// deferred.
export type RunWaitsRepositoryService = {
  readonly findMany: (
    spec: Specification<RunWaitRoot>,
  ) => Effect.Effect<ReadonlyArray<RunWaitRoot>>;
  readonly upsertOne: (wait: RunWaitRoot) => Effect.Effect<void>;
  readonly deleteOne: (wait: RunWaitRoot) => Effect.Effect<void>;
};

export class RunWaitsRepository extends Context.Service<
  RunWaitsRepository,
  RunWaitsRepositoryService
>()("RunWaitsRepository") {}
