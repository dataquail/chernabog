import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunLaneEntity } from "./run-lane.entity.ts";

// The lanes one run declared.
const forRun = (runId: RunId): Specification<RunLaneEntity> =>
  Spec.eq<RunLaneEntity, "runId">("runId", runId);

// One lane of one run.
const named = (runId: RunId, lane: string): Specification<RunLaneEntity> =>
  Spec.and(forRun(runId), Spec.eq<RunLaneEntity, "lane">("lane", lane));

export const RunLaneSpecifications = { forRun, named } as const;
