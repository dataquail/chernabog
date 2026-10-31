import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { checkRunValidityHandler } from "./queries/check-run-validity.handler.ts";
import { CheckRunValidityQuery } from "./queries/check-run-validity.query.ts";
import { findActiveRunHandler } from "./queries/find-active-run.handler.ts";
import { FindActiveRunQuery } from "./queries/find-active-run.query.ts";
import { findRunHandler } from "./queries/find-run.handler.ts";
import { FindRunQuery } from "./queries/find-run.query.ts";
import { followRunLogHandler } from "./queries/follow-run-log.handler.ts";
import { FollowRunLogQuery } from "./queries/follow-run-log.query.ts";
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
import { pollNotificationsHandler } from "./queries/poll-notifications.handler.ts";
import { PollNotificationsQuery } from "./queries/poll-notifications.query.ts";
import { readRunHistoryHandler } from "./queries/read-run-history.handler.ts";
import { ReadRunHistoryQuery } from "./queries/read-run-history.query.ts";
import { readRunLogHandler } from "./queries/read-run-log.handler.ts";
import { ReadRunLogQuery } from "./queries/read-run-log.query.ts";
import { readStateVersionHandler } from "./queries/read-state-version.handler.ts";
import { ReadStateVersionQuery } from "./queries/read-state-version.query.ts";
import { resolveRunIdHandler } from "./queries/resolve-run-id.handler.ts";
import { ResolveRunIdQuery } from "./queries/resolve-run-id.query.ts";
import {
  runFlowsQuerySpanAttributes,
  runLogsQuerySpanAttributes,
  runsQuerySpanAttributes,
} from "./runs.event-span-attributes.ts";

// What the runs' stores in state.db answer. Those stores share the SQL client
// the workflow engine journals to, so the handlers take them from the
// module's wiring, which a composition root that holds state.db (the daemon, a
// foreground run, a rehearsal) provides with its SQL client.
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
  ReadRunHistoryQuery,
  ReadStateVersionQuery,
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
  ReadRunHistoryQuery: (payload) => readRunHistoryHandler(payload),
  ReadStateVersionQuery: () => readStateVersionHandler(),
});

// The runs module's slice of the read side over state.db, which the daemon, a
// foreground run and the engine ask.
export class RunsQueries extends Context.Service<
  RunsQueries,
  Query.Dispatcher<typeof runsQueryGroup>
>()("RunsQueries") {}

export const RunsQueriesLive = Layer.effect(
  RunsQueries,
  Query.dispatcher(runsQueryGroup, { spanAttributes: runsQuerySpanAttributes }),
).pipe(Layer.provideMerge(RunsQueryHandlersLive));

// What the flows a process loaded answer about its runs, over the stores in
// state.db. The flows are built inside the engine, over those stores, so
// this group is the daemon's to provide over its runtime, as the runs'
// commands are, apart from the queries the engine itself asks.
export const runFlowsQueryGroup = Query.group(CheckRunValidityQuery);

const RunFlowsQueryHandlersLive = Query.handlersOf(runFlowsQueryGroup, {
  CheckRunValidityQuery: (payload) => checkRunValidityHandler(payload),
});

// The runs module's slice of the read side over the loaded flows, which the
// daemon asks whether a run's work item is still valid.
export class RunFlowsQueries extends Context.Service<
  RunFlowsQueries,
  Query.Dispatcher<typeof runFlowsQueryGroup>
>()("RunFlowsQueries") {}

export const RunFlowsQueriesLive = Layer.effect(
  RunFlowsQueries,
  Query.dispatcher(runFlowsQueryGroup, { spanAttributes: runFlowsQuerySpanAttributes }),
).pipe(Layer.provideMerge(RunFlowsQueryHandlersLive));

// What the runs' logs answer, which any process may read: the CLI reads them
// while the daemon, which holds state.db, writes them.
export const runLogsQueryGroup = Query.group(FollowRunLogQuery, ReadRunLogQuery, ResolveRunIdQuery);

const RunLogsQueryHandlersLive = Query.handlersOf(runLogsQueryGroup, {
  FollowRunLogQuery: (payload) => followRunLogHandler(payload),
  ReadRunLogQuery: (payload) => readRunLogHandler(payload),
  ResolveRunIdQuery: (payload) => resolveRunIdHandler(payload),
});

// The runs module's slice of the read side over run logs, which `logs`,
// `attach`, `rehearse --replay` and the live view ask.
export class RunLogsQueries extends Context.Service<
  RunLogsQueries,
  Query.Dispatcher<typeof runLogsQueryGroup>
>()("RunLogsQueries") {}

export const RunLogsQueriesLive = Layer.effect(
  RunLogsQueries,
  Query.dispatcher(runLogsQueryGroup, { spanAttributes: runLogsQuerySpanAttributes }),
).pipe(Layer.provideMerge(RunLogsQueryHandlersLive));

// What a persona's GitHub notifications answer.
export const notificationsQueryGroup = Query.group(PollNotificationsQuery);

const NotificationsQueryHandlersLive = Query.handlersOf(notificationsQueryGroup, {
  PollNotificationsQuery: (payload) => pollNotificationsHandler(payload),
});

// The runs module's slice of the read side over GitHub notifications, which
// the daemon asks to tick sooner.
export class NotificationsQueries extends Context.Service<
  NotificationsQueries,
  Query.Dispatcher<typeof notificationsQueryGroup>
>()("NotificationsQueries") {}

export const NotificationsQueriesLive = Layer.effect(
  NotificationsQueries,
  Query.dispatcher(notificationsQueryGroup),
).pipe(Layer.provideMerge(NotificationsQueryHandlersLive));
