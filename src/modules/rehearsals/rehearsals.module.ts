import * as Layer from "effect/Layer";

import { ScratchRepoClientLive } from "./infrastructure/clients/scratch-repo.client-live.ts";
import { ScenariosRepositoryLive } from "./infrastructure/repositories/scenarios.repository-live.ts";
import { RehearsalsCommandsLive } from "./rehearsals.command-handlers.ts";
import { RehearsalsQueriesLive } from "./rehearsals.query-handlers.ts";

// The rehearsals module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide.
export const RehearsalsModule = {
  layer: Layer.mergeAll(RehearsalsCommandsLive, RehearsalsQueriesLive).pipe(
    Layer.provide(Layer.mergeAll(ScenariosRepositoryLive, ScratchRepoClientLive)),
  ),
};
