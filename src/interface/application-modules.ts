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
// engine over state.db and the runtime of the flows the process loaded, which
// differ between roots, so each root provides them.
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
};
