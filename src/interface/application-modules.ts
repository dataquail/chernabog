import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EnrollmentModule } from "../modules/enrollment/enrollment.platform.ts";
import { MachineModule } from "../modules/machine/machine.platform.ts";
import { RecipesModule } from "../modules/recipes/recipes.platform.ts";
import { RehearsalsModule } from "../modules/rehearsals/rehearsals.platform.ts";
import { RunsModule } from "../modules/runs/runs.platform.ts";
import { TrustModule } from "../modules/trust/trust.platform.ts";

// Every module, once, for each composition root to merge (ADR 12): the CLI's,
// the daemon's, a foreground run's, a rehearsal's and the tests'. A set, not a
// sequence: each module's layer already provides what it closes over, and
// Effect memoizes a layer by reference, so one provided at several sites is
// built once. A module added here is wired everywhere.
//
// The two slots stay apart because they are provided at two depths. `layer` is
// what every process has, beneath the CLI's commands. `engine` is what a
// process that runs the workflow engine adds, inside that engine: it needs the
// engine over state.db and the runtime of the flows the process loaded
// (`runtime`, over the root's registry), which differ between roots, so each
// root passes them to the shared runtime (application-runtime.ts).
export const applicationModules = {
  layer: Layer.mergeAll(
    EnrollmentModule.layer,
    MachineModule.layer,
    RecipesModule.layer,
    RehearsalsModule.layer,
    RunsModule.layer,
    TrustModule.layer,
  ),
  engine: RunsModule.engine,
  runtime: RunsModule.runtime,

  // Each module's slice of the application's buses, which the shared runtime
  // (application-runtime.ts) builds them over: `routes` are the groups `layer`'s
  // dispatchers answer, with those dispatchers, and `engineRoutes` those
  // `engine` adds.
  routes: {
    commands: {
      groups: [
        ...EnrollmentModule.routes.commands.groups,
        ...MachineModule.routes.commands.groups,
        ...RecipesModule.routes.commands.groups,
        ...RehearsalsModule.routes.commands.groups,
        ...RunsModule.routes.commands.groups,
        ...TrustModule.routes.commands.groups,
      ],
      tables: Effect.map(
        Effect.all([
          EnrollmentModule.routes.commands.tables,
          MachineModule.routes.commands.tables,
          RecipesModule.routes.commands.tables,
          RehearsalsModule.routes.commands.tables,
          RunsModule.routes.commands.tables,
          TrustModule.routes.commands.tables,
        ]),
        Arr.flatten,
      ),
    },
    queries: {
      groups: [
        ...EnrollmentModule.routes.queries.groups,
        ...MachineModule.routes.queries.groups,
        ...RecipesModule.routes.queries.groups,
        ...RehearsalsModule.routes.queries.groups,
        ...RunsModule.routes.queries.groups,
        ...TrustModule.routes.queries.groups,
      ],
      tables: Effect.map(
        Effect.all([
          EnrollmentModule.routes.queries.tables,
          MachineModule.routes.queries.tables,
          RecipesModule.routes.queries.tables,
          RehearsalsModule.routes.queries.tables,
          RunsModule.routes.queries.tables,
          TrustModule.routes.queries.tables,
        ]),
        Arr.flatten,
      ),
    },
  },
  engineRoutes: RunsModule.engineRoutes,
};
