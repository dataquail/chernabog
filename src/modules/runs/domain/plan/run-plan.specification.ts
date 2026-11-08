import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunPlanEntity } from "./run-plan.entity.ts";

// The plan one run started with.
const forRun = (runId: RunId): Specification<RunPlanEntity> =>
  Spec.eq<RunPlanEntity, "runId">("runId", runId);

// A plan by its hash, whichever run started with it.
const withHash = (hash: string): Specification<RunPlanEntity> =>
  Spec.eq<RunPlanEntity, "hash">("hash", hash);

export const RunPlanSpecifications = { forRun, withHash } as const;
