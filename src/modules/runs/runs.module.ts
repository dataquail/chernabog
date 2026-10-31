import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Exec } from "../../platform/exec.ts";
import { GitHubApi } from "../../platform/github-api.ts";
import { unitOfWorkOver } from "../../platform/unit-of-work.ts";
import { FlowsClientLive } from "./infrastructure/clients/flows.client-live.ts";
import { NotificationsClientLive } from "./infrastructure/clients/notifications.client-live.ts";
import { RunCleanupClientLive } from "./infrastructure/clients/run-cleanup.client-live.ts";
import { RunLogsClientLive } from "./infrastructure/clients/run-logs.client-live.ts";
import { WorkflowsClientLive } from "./infrastructure/clients/workflows.client-live.ts";
import { HoldsRepositoryLive } from "./infrastructure/repositories/holds.repository-live.ts";
import { RunMarkersRepositoryLive } from "./infrastructure/repositories/run-markers.repository-live.ts";
import { RunStepsRepositoryLive } from "./infrastructure/repositories/run-steps.repository-live.ts";
import { RunWaitsRepositoryLive } from "./infrastructure/repositories/run-waits.repository-live.ts";
import { RunsRepositoryLive } from "./infrastructure/repositories/runs.repository-live.ts";
import { SkipsRepositoryLive } from "./infrastructure/repositories/skips.repository-live.ts";
import { StateDbTransactionDriverLive } from "./infrastructure/repositories/state-db.transaction-driver-live.ts";
import { type FlowRegistry } from "./infrastructure/runtime/flow-registry.ts";
import {
  runFlowsCommandGroup,
  RunFlowsCommands,
  RunFlowsCommandsLive,
  runsCommandGroup,
  RunsCommands,
  RunsCommandsLive,
} from "./runs.command-handlers.ts";
import {
  NotificationsQueries,
  NotificationsQueriesLive,
  notificationsQueryGroup,
  RunFlowsQueries,
  RunFlowsQueriesLive,
  runFlowsQueryGroup,
  RunLogsQueries,
  RunLogsQueriesLive,
  runLogsQueryGroup,
  RunsQueries,
  RunsQueriesLive,
  runsQueryGroup,
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

// The unit of work each of the runs' commands declares, over state.db: what a
// command writes there commits together or not at all, and what it dispatches
// on the bus is delivered once it has
// (docs/adr/0010-commands-declare-their-unit-of-work.md).
const RunsUnitOfWorkLive = unitOfWorkOver(StateDbTransactionDriverLive);

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
  // loaded, with the unit of work its commands declare over state.db. The SQL
  // client and the engine (EngineLive, EngineAt), and the runtime of the flows
  // the process loaded (`runtime`), differ between roots, so they stay in its
  // requirements, for each root to provide.
  engine: Layer.mergeAll(
    RunsCommandsLive,
    RunsQueriesLive,
    RunFlowsCommandsLive,
    RunFlowsQueriesLive,
  ).pipe(Layer.provide(Layer.mergeAll(RunsStoresLive, RunLogsClientLive, RunsUnitOfWorkLive))),

  // The runtime a tick and a run drive: the flows a process loaded, with each
  // persona's services, their workflows in the engine it runs, and cleaning up
  // after a run that's cancelled. Which flows those are is the composition
  // root's (the daemon's, a foreground run's, a rehearsal's, a cancel's), so
  // each root passes its registry, and provides this beneath `engine`.
  runtime: (registry: FlowRegistry) =>
    Layer.mergeAll(
      FlowsClientLive(registry),
      WorkflowsClientLive(registry.handles),
      RunCleanupClientLive(registry.services).pipe(Layer.provide(Exec.layer)),
    ).pipe(Layer.provide(RunsRepositoryLive)),

  // The unit of work the runs' commands declare, for a test that drives their
  // handlers itself beside the module (test/sdk-fakes.ts's StateAt): the same
  // Layer value, so Effect builds it once.
  unitOfWork: RunsUnitOfWorkLive,

  // The module's slice of the application's buses: the groups `layer`'s
  // dispatchers answer, and those dispatchers, as the tables a bus routes by;
  // and the same for `engine`'s.
  routes: {
    commands: { groups: [], tables: Effect.succeed([]) },
    queries: {
      groups: [runLogsQueryGroup, notificationsQueryGroup],
      tables: Effect.all([
        RunLogsQueries.use(Effect.succeed),
        NotificationsQueries.use(Effect.succeed),
      ]),
    },
  },
  engineRoutes: {
    commands: {
      groups: [runsCommandGroup, runFlowsCommandGroup],
      tables: Effect.all([RunsCommands.use(Effect.succeed), RunFlowsCommands.use(Effect.succeed)]),
    },
    queries: {
      groups: [runsQueryGroup, runFlowsQueryGroup],
      tables: Effect.all([RunsQueries.use(Effect.succeed), RunFlowsQueries.use(Effect.succeed)]),
    },
  },
};
