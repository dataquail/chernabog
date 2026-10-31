// The platform surface: what the composition roots and the inbound adapters name to
// assemble and drive this module — its dispatchers, its Layers, and the results and
// value objects its messages answer with. It declares nothing; anything not
// re-exported here is private to the module.

export { Routing } from "./domain/domain-services/routing.domain-service.ts";
export { HoldView } from "./domain/holds/hold-view.value-object.ts";
export { CancelledRun, CancelTarget } from "./domain/run/cancelled-run.value-object.ts";
export {
  PullRequestOpened,
  RunEnteredStep,
  RunFinished,
  RunNeedsAttention,
  RunStarted,
} from "./domain/run/run.events.ts";
export { RunHistory } from "./domain/run/run-history.value-object.ts";
export { ActiveRun, RunView } from "./domain/run/run-view.value-object.ts";
export { RunMarkersReleased } from "./domain/run-marker/run-marker.events.ts";
export { MarkerReleases, RunMarkerView } from "./domain/run-marker/run-marker-view.value-object.ts";
export {
  causeOf,
  DEFAULT_EVENT_TICK_MIN,
  eventTickAt,
  localCause,
  noteEvent,
  type PendingTick,
} from "./domain/schedule/event-tick.value-object.ts";
export {
  DEFAULT_LEASE_LIMITS,
  leaseTtlFor,
  renewalDue,
  RunLeases,
} from "./domain/schedule/lease.value-object.ts";
export { type NotificationNews } from "./domain/schedule/notifications.value-object.ts";
export { cronProblem, nextTick } from "./domain/schedule/schedule.value-object.ts";
export {
  type CheckFailures,
  DEFAULT_VALIDITY_EVERY,
  noteCheckFailure,
  runIsAbout,
  RunValidity,
  validityDue,
} from "./domain/schedule/validity.value-object.ts";
export { SkipView } from "./domain/skip/skip-view.value-object.ts";
export { RunLog } from "./queries/read-run-log.query.ts";
export { RunFlowsCommands, RunsCommands } from "./runs.command-handlers.ts";
export { RunsModule } from "./runs.module.ts";
export {
  NotificationsQueries,
  RunFlowsQueries,
  RunLogsQueries,
  RunsQueries,
} from "./runs.query-handlers.ts";

// The services the runs module leaves to each composition root that runs the
// workflow engine: the engine and its SQL client over state.db, and the
// registry of the flows that root loaded, which RunsModule.runtime runs. And
// what the runs' events say on their spans, for the one bus the shared runtime
// builds.
export { EngineAt, EngineLive } from "./infrastructure/runtime/engine.ts";
export { type FlowRegistry } from "./infrastructure/runtime/flow-registry.ts";
export { runEventSpanAttributes } from "./runs.event-span-attributes.ts";

// Interim: the runtime the roots still compose directly (the engine, launchers, run
// logs, repo runtime, agents, the usage gate, labels, steps and the launch shim).
// It is published here only until the runtime finishes moving into the module behind
// its commands, queries and Layers; each line goes when its root stops naming it.
export {
  type AttachCommand,
  attachCommand,
  liveAttach,
  runSessions,
} from "./infrastructure/runtime/agents.ts";
export { runAnswers, runUnanswered } from "./infrastructure/runtime/agents/answers.ts";
export {
  Draft,
  handOver,
  questionFor,
  questionHook,
  worktreeAt,
} from "./infrastructure/runtime/agents/open-pr-question.ts";
export { REHEARSAL } from "./infrastructure/runtime/agents/rehearsal.ts";
export {
  readDecoded,
  SESSION_ENV,
  sessionFilesIn,
} from "./infrastructure/runtime/agents/session-files.ts";
export { checkAnswer, stopHook } from "./infrastructure/runtime/agents/stop-hook.ts";
export { checkCodexAccount } from "./infrastructure/runtime/codex-usage.ts";
export { flowWarnings } from "./infrastructure/runtime/diagnostics.ts";
export {
  defaultPersona,
  type FlowHandle,
  flowHandle,
  flowLayer,
  runLogFile,
} from "./infrastructure/runtime/engine.ts";
export {
  declaredLabels,
  Label,
  planLabelSync,
  syncLabels,
} from "./infrastructure/runtime/labels.ts";
export { describeLauncher, launcherFor } from "./infrastructure/runtime/launchers.ts";
export { LaunchSpecJson, runLaunch } from "./infrastructure/runtime/launchers/shim.ts";
export {
  adoptRuns,
  buildPersonaContexts,
  flowOrigins,
  openRepo,
  type PersonaContext,
  repoConfigDir,
  type RepoContext,
  servicesFrom,
  unreportedItem,
  withRepo,
} from "./infrastructure/runtime/repo-runtime.ts";
export { runLogWriting } from "./infrastructure/runtime/runlog.ts";
export { runStepChild, StepServicesLive } from "./infrastructure/runtime/steps.ts";
export {
  checkAccount,
  loggedInEmail,
  readUsageLogLine,
} from "./infrastructure/runtime/usage-gate.ts";
