import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type TeamConfigRoot } from "./team-config.root.ts";

// The team's config of the checkout at `root`.
const ofCheckout = (root: string): Specification<TeamConfigRoot> =>
  Spec.eq<TeamConfigRoot, "root">("root", root);

export const TeamConfigSpecifications = { ofCheckout } as const;
