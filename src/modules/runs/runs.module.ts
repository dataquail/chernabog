import * as Layer from "effect/Layer";

import { GitHubApi } from "../../platform/github-api.ts";
import { NotificationsClientLive } from "./infrastructure/clients/notifications.client-live.ts";
import { RunLogsClientLive } from "./infrastructure/clients/run-logs.client-live.ts";
import { HoldsRepositoryLive } from "./infrastructure/repositories/holds.repository-live.ts";
import { RunMarkersRepositoryLive } from "./infrastructure/repositories/run-markers.repository-live.ts";
import { RunStepsRepositoryLive } from "./infrastructure/repositories/run-steps.repository-live.ts";
import { RunWaitsRepositoryLive } from "./infrastructure/repositories/run-waits.repository-live.ts";
import { RunsRepositoryLive } from "./infrastructure/repositories/runs.repository-live.ts";
import { SkipsRepositoryLive } from "./infrastructure/repositories/skips.repository-live.ts";
import { RunFlowsCommandsLive, RunsCommandsLive } from "./runs.command-handlers.ts";
import {
  NotificationsQueriesLive,
  RunFlowsQueriesLive,
  RunLogsQueriesLive,
  RunsQueriesLive,
} from "./runs.query-handlers.ts";

// The runs' stores in state.db.
const RunsStoresLive = Layer.mergeAll(
  RunsRepositoryLive,
  RunMarkersRepositoryLive,
  RunStepsRepositoryLive,
  RunWaitsRepositoryLive,
  SkipsRepositoryLive,
  HoldsRepositoryLive,
);

// The runs module, wired.
export const RunsModule = {
  // What any process may ask: the run logs, which the CLI reads while the
  // daemon writes them, and each persona's GitHub notifications, which the
  // daemon polls to tick sooner.
  layer: Layer.mergeAll(RunLogsQueriesLive, NotificationsQueriesLive).pipe(
    Layer.provide(Layer.mergeAll(RunLogsClientLive, NotificationsClientLive(GitHubApi.layerFor))),
  ),

  // What a process that runs the workflow engine dispatches: the runs' commands
  // and queries over their stores in state.db, and those over the flows it
  // loaded. The SQL client and the engine (EngineLive, EngineAt), and the
  // runtime of the flows the process loaded (RuntimeLayer), differ between
  // roots, so they stay in its requirements, for each root to provide.
  engine: Layer.mergeAll(
    RunsCommandsLive,
    RunsQueriesLive,
    RunFlowsCommandsLive,
    RunFlowsQueriesLive,
  ).pipe(Layer.provide(Layer.mergeAll(RunsStoresLive, RunLogsClientLive))),
};
