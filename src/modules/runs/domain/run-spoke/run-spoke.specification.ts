import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunSpokeRoot } from "./run-spoke.root.ts";

// Every spoke's record.
const all: Specification<RunSpokeRoot> = Spec.all<RunSpokeRoot>();

// One run's spoke.
const forRun = (runId: RunId): Specification<RunSpokeRoot> =>
  Spec.eq<RunSpokeRoot, "runId">("runId", runId);

export const RunSpokeSpecifications = { all, forRun } as const;
