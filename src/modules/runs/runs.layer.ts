import * as Layer from "effect/Layer";

import { RunLogsClientLive } from "./infrastructure/clients/run-logs.client-live.ts";
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

// Run logs, which any process may read: the CLI reads them while the daemon,
// which holds state.db, writes them.
export const RunLogsLayer = RunLogsClientLive;
