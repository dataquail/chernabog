import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type SkipRoot } from "./skip.root.ts";

// Every skip logged.
const all: Specification<SkipRoot> = Spec.all<SkipRoot>();

// The skips of one repo's flow.
const forFlow = (repo: string, flow: string): Specification<SkipRoot> =>
  Spec.and(Spec.eq<SkipRoot, "repo">("repo", repo), Spec.eq<SkipRoot, "flow">("flow", flow));

export const SkipSpecifications = { all, forFlow } as const;
