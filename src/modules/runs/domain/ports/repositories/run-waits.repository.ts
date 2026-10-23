import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type RunWaitRoot } from "../../run-wait/run-wait.root.ts";

// The waits runs are parked on: `findAll` reads one run's, or, with none, every
// run's. A wait is one run's deferred, so saving one replaces the run's wait
// on the same deferred.
export type RunWaitsRepositoryService = {
  readonly findAll: (runId: Option.Option<RunId>) => Effect.Effect<ReadonlyArray<RunWaitRoot>>;
  readonly save: (wait: RunWaitRoot) => Effect.Effect<void>;
  readonly remove: (wait: RunWaitRoot) => Effect.Effect<void>;
};

export class RunWaitsRepository extends Context.Service<
  RunWaitsRepository,
  RunWaitsRepositoryService
>()("RunWaitsRepository") {}
