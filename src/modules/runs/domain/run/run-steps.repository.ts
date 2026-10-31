import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunStepEntity } from "./run-step.entity.ts";

// The steps runs entered, as a log: `insertOne` adds one, and `findMany` reads
// those a spec (RunStepSpecifications) holds of, in the order they were entered.
export type RunStepsRepositoryService = {
  readonly findMany: (
    spec: Specification<RunStepEntity>,
  ) => Effect.Effect<ReadonlyArray<RunStepEntity>>;
  readonly insertOne: (step: RunStepEntity) => Effect.Effect<void>;
};

export class RunStepsRepository extends Context.Service<
  RunStepsRepository,
  RunStepsRepositoryService
>()("RunStepsRepository") {}
