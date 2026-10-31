import * as Layer from "effect/Layer";

import { TeamFlowsAclLive } from "./infrastructure/acl/team-flows.acl-live.ts";
import { CheckoutsClientLive } from "./infrastructure/clients/checkouts.client-live.ts";
import { ViewerClientLive } from "./infrastructure/clients/viewer.client-live.ts";
import { EnrolledReposRepositoryLive } from "./infrastructure/repositories/enrolled-repos.repository-live.ts";

// The enrollment module's live adapters, for a composition root to provide.
// Its ACL adapters ask other modules' published queries, so the root provides
// those modules' dispatchers beneath it (enrollment.imports.ts lists them).
export const EnrollmentLayer = Layer.mergeAll(
  EnrolledReposRepositoryLive,
  CheckoutsClientLive,
  ViewerClientLive,
  TeamFlowsAclLive,
);
