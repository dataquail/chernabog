import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Home, homePaths } from "../../platform/home.ts";
import { type FlowRegistry, FlowsClientLive } from "./infrastructure/clients/flows.client-live.ts";
import { RunLogsClientLive } from "./infrastructure/clients/run-logs.client-live.ts";
import { WorkflowsClientLive } from "./infrastructure/clients/workflows.client-live.ts";
import { RunWaitsRepositoryLive } from "./infrastructure/repositories/run-waits.repository-live.ts";
import { RunsRepositoryLive } from "./infrastructure/repositories/runs.repository-live.ts";
import { SkipsRepositoryLive } from "./infrastructure/repositories/skips.repository-live.ts";
import { EngineAt } from "./infrastructure/runtime/engine.ts";

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

export type { FlowRegistry };

// The runtime a tick and a run drive: the flows a process loaded, with each
// persona's services, and their workflows in the engine it runs. Built inside
// that engine, and over the runs' stores.
export const RuntimeLayer = (registry: FlowRegistry) =>
  Layer.mergeAll(FlowsClientLive(registry), WorkflowsClientLive(registry.handles));

// The workflow engine, and the runs' stores beside its journal, in `database`.
export const StateAt = (database: string) => RunsLayer.pipe(Layer.provideMerge(EngineAt(database)));

// The engine and the runs in this machine's state.db.
export const StateLive = Layer.unwrap(
  Home.use((home) => Effect.succeed(StateAt(homePaths(home.root).state))),
);
