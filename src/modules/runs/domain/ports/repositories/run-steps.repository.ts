import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type RunStepEntity } from "../../run/run-step.entity.ts";

// The steps runs entered, as a log: `save` adds one, and `findAll` reads one
// run's in the order it entered them.
export type RunStepsRepositoryService = {
  readonly findAll: (runId: RunId) => Effect.Effect<ReadonlyArray<RunStepEntity>>;
  readonly save: (step: RunStepEntity) => Effect.Effect<void>;
};

export class RunStepsRepository extends Context.Service<
  RunStepsRepository,
  RunStepsRepositoryService
>()("RunStepsRepository") {}
