import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ScratchRepoClientLive } from "./infrastructure/clients/scratch-repo.client-live.ts";
import { ScenariosRepositoryLive } from "./infrastructure/repositories/scenarios.repository-live.ts";
import {
  rehearsalsCommandGroup,
  RehearsalsCommands,
  RehearsalsCommandsLive,
} from "./rehearsals.command-handlers.ts";
import {
  RehearsalsQueries,
  RehearsalsQueriesLive,
  rehearsalsQueryGroup,
} from "./rehearsals.query-handlers.ts";

// The rehearsals module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide.
export const RehearsalsModule = {
  layer: Layer.mergeAll(RehearsalsCommandsLive, RehearsalsQueriesLive).pipe(
    Layer.provide(Layer.mergeAll(ScenariosRepositoryLive, ScratchRepoClientLive)),
  ),

  // The module's slice of the application's buses: the groups `layer`'s
  // dispatchers answer, and those dispatchers, as the tables a bus routes by.
  routes: {
    commands: {
      groups: [rehearsalsCommandGroup],
      tables: Effect.all([RehearsalsCommands.use(Effect.succeed)]),
    },
    queries: {
      groups: [rehearsalsQueryGroup],
      tables: Effect.all([RehearsalsQueries.use(Effect.succeed)]),
    },
  },
};
