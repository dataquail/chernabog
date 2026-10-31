import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type MarkerStatus } from "./marker-status.value-object.ts";
import { type RunMarkerRoot } from "./run-marker.root.ts";

// Every marker of every run.
const all: Specification<RunMarkerRoot> = Spec.all<RunMarkerRoot>();

// One run's markers.
const forRun = (runId: RunId): Specification<RunMarkerRoot> =>
  Spec.eq<RunMarkerRoot, "runId">("runId", runId);

// The markers in one status, such as those still held.
const inStatus = (status: MarkerStatus): Specification<RunMarkerRoot> =>
  Spec.eq<RunMarkerRoot, "status">("status", status);

export const RunMarkerSpecifications = { all, forRun, inStatus } as const;
