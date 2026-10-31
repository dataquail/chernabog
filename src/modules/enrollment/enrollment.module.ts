import * as Layer from "effect/Layer";

import { EnrollmentCommandsLive } from "./enrollment.command-handlers.ts";
import { EnrollmentQueriesLive } from "./enrollment.query-handlers.ts";
import { CheckoutsClientLive } from "./infrastructure/clients/checkouts.client-live.ts";
import { ViewerClientLive } from "./infrastructure/clients/viewer.client-live.ts";
import { EnrolledReposRepositoryLive } from "./infrastructure/repositories/enrolled-repos.repository-live.ts";

// The enrollment module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide.
export const EnrollmentModule = {
  layer: Layer.mergeAll(EnrollmentCommandsLive, EnrollmentQueriesLive).pipe(
    Layer.provide(
      Layer.mergeAll(EnrolledReposRepositoryLive, CheckoutsClientLive, ViewerClientLive),
    ),
  ),
};
