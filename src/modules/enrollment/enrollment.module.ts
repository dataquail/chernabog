import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RecipesModule } from "../recipes/recipes.module.ts";
import {
  enrollmentCommandGroup,
  EnrollmentCommands,
  EnrollmentCommandsLive,
} from "./enrollment.command-handlers.ts";
import {
  EnrollmentQueries,
  EnrollmentQueriesLive,
  enrollmentQueryGroup,
} from "./enrollment.query-handlers.ts";
import { TeamFlowsAclLive } from "./infrastructure/acl/team-flows.acl-live.ts";
import { CheckoutsClientLive } from "./infrastructure/clients/checkouts.client-live.ts";
import { ViewerClientLive } from "./infrastructure/clients/viewer.client-live.ts";
import { EnrolledReposRepositoryLive } from "./infrastructure/repositories/enrolled-repos.repository-live.ts";

// The enrollment module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide. Its ACL adapters ask the modules enrollment.imports.ts lists, so it
// provides those modules beneath them: enrollment asks recipes the team's config.
export const EnrollmentModule = {
  layer: Layer.mergeAll(EnrollmentCommandsLive, EnrollmentQueriesLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        EnrolledReposRepositoryLive,
        CheckoutsClientLive,
        ViewerClientLive,
        TeamFlowsAclLive.pipe(Layer.provide(RecipesModule.layer)),
      ),
    ),
  ),

  // The module's slice of the application's buses: the groups `layer`'s
  // dispatchers answer, and those dispatchers, as the tables a bus routes by.
  routes: {
    commands: {
      groups: [enrollmentCommandGroup],
      tables: Effect.all([EnrollmentCommands.use(Effect.succeed)]),
    },
    queries: {
      groups: [enrollmentQueryGroup],
      tables: Effect.all([EnrollmentQueries.use(Effect.succeed)]),
    },
  },
};
