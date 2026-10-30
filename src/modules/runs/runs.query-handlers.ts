import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { RunLogsClientLive } from "./infrastructure/clients/run-logs.client-live.ts";
import { findActiveRunHandler } from "./queries/find-active-run.handler.ts";
import { FindActiveRunQuery } from "./queries/find-active-run.query.ts";
import { findRunHandler } from "./queries/find-run.handler.ts";
import { FindRunQuery } from "./queries/find-run.query.ts";
import { listActiveRunsHandler } from "./queries/list-active-runs.handler.ts";
import { ListActiveRunsQuery } from "./queries/list-active-runs.query.ts";
import { listHoldsHandler } from "./queries/list-holds.handler.ts";
import { ListHoldsQuery } from "./queries/list-holds.query.ts";
import { listRecentRunsHandler } from "./queries/list-recent-runs.handler.ts";
import { ListRecentRunsQuery } from "./queries/list-recent-runs.query.ts";
import { listRecentSkipsHandler } from "./queries/list-recent-skips.handler.ts";
import { ListRecentSkipsQuery } from "./queries/list-recent-skips.query.ts";
import { listRunMarkersHandler } from "./queries/list-run-markers.handler.ts";
import { ListRunMarkersQuery } from "./queries/list-run-markers.query.ts";
import { listRunWaitsHandler } from "./queries/list-run-waits.handler.ts";
import { ListRunWaitsQuery } from "./queries/list-run-waits.query.ts";
import { listUnreleasedMarkersHandler } from "./queries/list-unreleased-markers.handler.ts";
import { ListUnreleasedMarkersQuery } from "./queries/list-unreleased-markers.query.ts";
import { listUnsupportedRunsHandler } from "./queries/list-unsupported-runs.handler.ts";
import { ListUnsupportedRunsQuery } from "./queries/list-unsupported-runs.query.ts";
import { resolveRunIdHandler } from "./queries/resolve-run-id.handler.ts";
import { ResolveRunIdQuery } from "./queries/resolve-run-id.query.ts";

// What the runs' stores in state.db answer. Those stores share the SQL client
// the workflow engine journals to, so the handlers take them from the
// composition root that holds state.db (the daemon, a foreground run, the
// engine), not from a layer of their own.
export const runsQueryGroup = Query.group(
  FindActiveRunQuery,
  FindRunQuery,
  ListActiveRunsQuery,
  ListHoldsQuery,
  ListRecentRunsQuery,
  ListRecentSkipsQuery,
  ListRunMarkersQuery,
  ListRunWaitsQuery,
  ListUnreleasedMarkersQuery,
  ListUnsupportedRunsQuery,
);

const RunsQueryHandlersLive = Query.handlersOf(runsQueryGroup, {
  FindActiveRunQuery: (payload) => findActiveRunHandler(payload),
  FindRunQuery: (payload) => findRunHandler(payload),
  ListActiveRunsQuery: (payload) => listActiveRunsHandler(payload),
  ListHoldsQuery: () => listHoldsHandler(),
  ListRecentRunsQuery: (payload) => listRecentRunsHandler(payload),
  ListRecentSkipsQuery: (payload) => listRecentSkipsHandler(payload),
  ListRunMarkersQuery: (payload) => listRunMarkersHandler(payload),
  ListRunWaitsQuery: (payload) => listRunWaitsHandler(payload),
  ListUnreleasedMarkersQuery: () => listUnreleasedMarkersHandler(),
  ListUnsupportedRunsQuery: () => listUnsupportedRunsHandler(),
});

// The runs module's slice of the read side over state.db, which the daemon, a
// foreground run and the engine ask.
export class RunsQueries extends Context.Service<
  RunsQueries,
  Query.Dispatcher<typeof runsQueryGroup>
>()("RunsQueries") {}

export const RunsQueriesLive = Layer.effect(RunsQueries, Query.dispatcher(runsQueryGroup)).pipe(
  Layer.provideMerge(RunsQueryHandlersLive),
);

// What the runs' logs answer, which any process may read: the CLI reads them
// while the daemon, which holds state.db, writes them.
export const runLogsQueryGroup = Query.group(ResolveRunIdQuery);

const RunLogsQueryHandlersLive = Query.handlersOf(runLogsQueryGroup, {
  ResolveRunIdQuery: (payload) => resolveRunIdHandler(payload),
}).pipe(Layer.provide(RunLogsClientLive));

// The runs module's slice of the read side over run logs, which `logs`,
// `attach` and `rehearse --replay` ask.
export class RunLogsQueries extends Context.Service<
  RunLogsQueries,
  Query.Dispatcher<typeof runLogsQueryGroup>
>()("RunLogsQueries") {}

export const RunLogsQueriesLive = Layer.effect(
  RunLogsQueries,
  Query.dispatcher(runLogsQueryGroup),
).pipe(Layer.provideMerge(RunLogsQueryHandlersLive));
