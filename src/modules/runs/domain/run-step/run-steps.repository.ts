import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunStepRoot } from "./run-step.root.ts";

// The steps runs entered, as a log: `insertOne` adds one, and `findMany` reads
// those a spec (RunStepSpecifications) holds of, in the order they were entered.
export type RunStepsRepositoryService = {
  readonly findMany: (
    spec: Specification<RunStepRoot>,
  ) => Effect.Effect<ReadonlyArray<RunStepRoot>>;
  readonly insertOne: (step: RunStepRoot) => Effect.Effect<void>;
};

export class RunStepsRepository extends Context.Service<
  RunStepsRepository,
  RunStepsRepositoryService
>()("RunStepsRepository") {}
