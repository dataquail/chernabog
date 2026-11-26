// The platform surface: what the composition roots and the inbound adapters name to
// assemble and drive this module — its dispatchers, its Layers, and the results and
// value objects its messages answer with. It declares nothing; anything not
// re-exported here is private to the module.

export { Routing } from "./domain/domain-services/routing.domain-service.ts";
export { HoldView } from "./domain/holds/hold-view.value-object.ts";
export { FlowPlan, FoundPlan } from "./domain/plan/flow-plan.value-object.ts";
export {
  type AgentSessionOpened,
  sessionOpenedIn,
} from "./domain/run/agent-session-opened.value-object.ts";
export { CancelledRun, CancelTarget } from "./domain/run/cancelled-run.value-object.ts";
export { type EndedSpoke } from "./domain/run/ended-spoke.value-object.ts";
export {
  PullRequestOpened,
  RunEnteredNode,
  RunEnteredStep,
  RunFinished,
  RunFinishedNode,
  RunFinishedStep,
  RunNeedsAttention,
  RunReachedEnd,
  RunStarted,
  RunTookBranch,
} from "./domain/run/run.events.ts";
export { RunHistory } from "./domain/run/run-history.value-object.ts";
export { type RunStatus } from "./domain/run/run-status.value-object.ts";
export { ActiveRun, RunView } from "./domain/run/run-view.value-object.ts";
export { SpokeEnding } from "./domain/run/spoke-ending.value-object.ts";
export { SpokeHandOver, SpokeHandOverJson } from "./domain/run/spoke-hand-over.value-object.ts";
export { type SpokeReport } from "./domain/run/spoke-report.value-object.ts";
export { type FlowRef, WorkItem } from "./domain/run/work-item.value-object.ts";
export { RunMarkersReleased } from "./domain/run-marker/run-marker.events.ts";
export { MarkerReleases, RunMarkerView } from "./domain/run-marker/run-marker-view.value-object.ts";
export { endingOf, SpokeEndRequest } from "./domain/run-spoke/spoke-end-request.value-object.ts";
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
export { SpokeRecordView } from "./queries/list-spokes.query.ts";
export { LoggedAt, RunLog } from "./queries/read-run-log.query.ts";
export {
  RunFlowsCommands,
  RunsCommands,
  SpokeReportCommand,
  spokeReportCommands,
  spokeReportPayloadJson,
} from "./runs.command-handlers.ts";
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
export {
  EngineAt,
  EngineLive,
  recordsOfRun,
  SpokeEngineAt,
  SpokeEngineLive,
} from "./infrastructure/runtime/engine.ts";
export { type FlowRegistry } from "./infrastructure/runtime/flow-registry.ts";
export { runEventSpanAttributes } from "./runs.event-span-attributes.ts";

// Interim: the runtime the roots still compose directly (the engine, launchers, run
// logs, repo runtime, agents, the usage gate, labels, steps and the launch shim).
// It is published here only until the runtime finishes moving into the module behind
// its commands, queries and Layers; each line goes when its root stops naming it.
export { CiPlan } from "./domain/domain-services/ci-plan.domain-service.ts";
export {
  SECRETS as CI_SECRETS,
  WORKFLOW_FILE as CI_WORKFLOW_FILE,
  CiWorkflow,
} from "./domain/domain-services/ci-workflow.domain-service.ts";
export {
  type AttachCommand,
  attachCommand,
  liveAttach,
  OpenRefused,
  openRunSession,
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
  knownLaunch,
  readDecoded,
  readText,
  SESSION_ENV,
  sessionFiles,
  sessionFilesIn,
} from "./infrastructure/runtime/agents/session-files.ts";
export { checkAnswer, stopHook } from "./infrastructure/runtime/agents/stop-hook.ts";
export { type CiEvent, type CiPlanResult, planCi } from "./infrastructure/runtime/ci-plan.ts";
export {
  ciWorkflowFor,
  type CiWorkflowSettings,
  type CiWorkflowText,
  type WorkflowFiles,
} from "./infrastructure/runtime/ci-workflow.ts";
export { checkCodexAccount } from "./infrastructure/runtime/codex-usage.ts";
export { flowWarnings } from "./infrastructure/runtime/diagnostics.ts";
export {
  defaultPersona,
  type FlowHandle,
  flowHandle,
  flowLayer,
  runLogFile,
  runLogFor,
} from "./infrastructure/runtime/engine.ts";
export { type LabelDrift, labelDrift } from "./infrastructure/runtime/label-drift.ts";
export {
  declaredLabels,
  Label,
  planLabelSync,
  syncLabels,
} from "./infrastructure/runtime/labels.ts";
export {
  describeLauncher,
  launcherFor,
  opensSessions,
} from "./infrastructure/runtime/launchers.ts";
export { LaunchSpecJson, runLaunch } from "./infrastructure/runtime/launchers/shim.ts";
export {
  type AnomaliesResult,
  type Anomaly,
  parseSeen,
  progressAnomalies,
  type Seen,
} from "./infrastructure/runtime/progress-anomalies.ts";
export {
  type BackfillFinding,
  backfillProgress,
  type BackfillResult,
} from "./infrastructure/runtime/progress-backfill.ts";
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
  withRepoReservedFor,
} from "./infrastructure/runtime/repo-runtime.ts";
export { noHooks, RunLogLimit, runLogWriting } from "./infrastructure/runtime/runlog.ts";
export { runStepChild, StepServicesLive } from "./infrastructure/runtime/steps.ts";
export {
  checkThreadsSetup,
  personalRepo,
  setupFix,
  type ThreadsSetup,
} from "./infrastructure/runtime/threads-setup.ts";
export {
  checkAccount,
  loggedInEmail,
  readUsageLogLine,
} from "./infrastructure/runtime/usage-gate.ts";
