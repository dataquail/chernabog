import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunNodeEntity } from "./run-node.entity.ts";

// The marks one run left at the nodes of its plan.
const forRun = (runId: RunId): Specification<RunNodeEntity> =>
  Spec.eq<RunNodeEntity, "runId">("runId", runId);

export const RunNodeSpecifications = { forRun } as const;
