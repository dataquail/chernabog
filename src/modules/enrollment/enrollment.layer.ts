import * as Layer from "effect/Layer";

import { CheckoutsClientLive } from "./infrastructure/clients/checkouts.client-live.ts";
import { ViewerClientLive } from "./infrastructure/clients/viewer.client-live.ts";
import { EnrolledReposRepositoryLive } from "./infrastructure/repositories/enrolled-repos.repository-live.ts";

// The enrollment module's live adapters, for a composition root to provide.
export const EnrollmentLayer = Layer.mergeAll(
  EnrolledReposRepositoryLive,
  CheckoutsClientLive,
  ViewerClientLive,
);
