import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type HoldsRoot } from "./holds.root.ts";

// Every flow's holds.
const all: Specification<HoldsRoot> = Spec.all<HoldsRoot>();

// The holds of one repo's flows.
const forRepo = (repo: string): Specification<HoldsRoot> =>
  Spec.eq<HoldsRoot, "repo">("repo", repo);

export const HoldsSpecifications = { all, forRepo } as const;
