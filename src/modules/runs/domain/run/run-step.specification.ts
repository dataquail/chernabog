import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunStepEntity } from "./run-step.entity.ts";

// The steps one run entered.
const forRun = (runId: RunId): Specification<RunStepEntity> =>
  Spec.eq<RunStepEntity, "runId">("runId", runId);

export const RunStepSpecifications = { forRun } as const;
