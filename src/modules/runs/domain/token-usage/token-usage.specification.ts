import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type TokenUsageRoot } from "./token-usage.root.ts";

// What one run's agent calls spent.
const forRun = (runId: RunId): Specification<TokenUsageRoot> =>
  Spec.eq<TokenUsageRoot, "runId">("runId", runId);

export const TokenUsageSpecifications = { forRun } as const;
