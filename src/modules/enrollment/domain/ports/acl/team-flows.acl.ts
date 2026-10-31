import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type CheckoutUnreadable } from "../../enrolled-repo/enrolled-repo.errors.ts";
import { type TeamFlows } from "../../enrolled-repo/team-flows.value-object.ts";

// What the team says of a checkout's flows, which enrolling offers as its
// defaults. Another module owns the team's config; this is the question
// enrollment asks of it, in enrollment's own words.
export type TeamFlowsAclService = {
  readonly of: (root: string) => Effect.Effect<TeamFlows, CheckoutUnreadable>;
};

export class TeamFlowsAcl extends Context.Service<TeamFlowsAcl, TeamFlowsAclService>()(
  "TeamFlowsAcl",
) {}
