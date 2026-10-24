import * as Layer from "effect/Layer";

import { ScratchRepoClientLive } from "./infrastructure/clients/scratch-repo.client-live.ts";
import { ScenariosRepositoryLive } from "./infrastructure/repositories/scenarios.repository-live.ts";

// The rehearsals module's live adapters, for a composition root to provide.
export const RehearsalsLayer = Layer.mergeAll(ScenariosRepositoryLive, ScratchRepoClientLive);
