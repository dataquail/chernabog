import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunPlanEntity } from "./run-plan.entity.ts";

// The plans runs started with, each plan kept once by its hash: `insertOne`
// keeps a run's plan, and changes nothing for a run that has one already, so
// a run keeps the plan it started with; `findOne` reads the first a spec
// (RunPlanSpecifications) holds of.
export type RunPlansRepositoryService = {
  readonly findOne: (
    spec: Specification<RunPlanEntity>,
  ) => Effect.Effect<Option.Option<RunPlanEntity>>;
  readonly insertOne: (plan: RunPlanEntity) => Effect.Effect<void>;
};

export class RunPlansRepository extends Context.Service<
  RunPlansRepository,
  RunPlansRepositoryService
>()("RunPlansRepository") {}
