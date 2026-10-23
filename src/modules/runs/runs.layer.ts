import * as Layer from "effect/Layer";

import { RunWaitsRepositoryLive } from "./infrastructure/repositories/run-waits.repository-live.ts";
import { RunsRepositoryLive } from "./infrastructure/repositories/runs.repository-live.ts";
import { SkipsRepositoryLive } from "./infrastructure/repositories/skips.repository-live.ts";

// The runs module's live adapters over state.db, for a composition root to
// provide with the SQL client the workflow engine journals to.
export const RunsLayer = Layer.mergeAll(
  RunsRepositoryLive,
  RunWaitsRepositoryLive,
  SkipsRepositoryLive,
);
