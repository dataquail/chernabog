import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunStepRoot } from "./run-step.root.ts";

// The steps one run entered.
const forRun = (runId: RunId): Specification<RunStepRoot> =>
  Spec.eq<RunStepRoot, "runId">("runId", runId);

export const RunStepSpecifications = { forRun } as const;
