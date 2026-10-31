import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunWaitRoot } from "./run-wait.root.ts";

// Every run's waits.
const all: Specification<RunWaitRoot> = Spec.all<RunWaitRoot>();

// One run's waits.
const forRun = (runId: RunId): Specification<RunWaitRoot> =>
  Spec.eq<RunWaitRoot, "runId">("runId", runId);

export const RunWaitSpecifications = { all, forRun } as const;
