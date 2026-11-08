// The contracts surface: the value objects and events the daemon's protocol
// carries over JSON (src/interface/daemon/daemon.protocol.ts), re-exported
// from the domain alone. The dashboard decodes with the protocol in a
// browser, so nothing reached from here may name an adapter, the platform or
// Bun's runtime; runs.platform.ts, which publishes the engine, would. It
// also carries the pure domain services every client draws a run with, so
// the dashboard and the TUI put a run on its plan the one way.

export {
  type LaidOutLane,
  type LaneEdge,
  type LaneLayout,
  LaneLayouts,
  type LaneNeeds,
} from "./domain/domain-services/lane-layout.domain-service.ts";
export {
  type BranchOnPlan,
  type LaneOnPlan,
  type NodeOnPlan,
  type NodeState,
  type OffPlan,
  type RoundOnPlan,
  RunOnPlan,
  type RunFacts as RunOnPlanFacts,
} from "./domain/domain-services/run-on-plan.domain-service.ts";
export { HoldView } from "./domain/holds/hold-view.value-object.ts";
export {
  FlowPlan,
  FoundPlan,
  type PlanBranch,
  PlanNode,
} from "./domain/plan/flow-plan.value-object.ts";
export { NodeRef } from "./domain/plan/node-ref.value-object.ts";
export { CancelTarget } from "./domain/run/cancelled-run.value-object.ts";
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
export { ActiveRun, RunView } from "./domain/run/run-view.value-object.ts";
export { RunMarkersReleased } from "./domain/run-marker/run-marker.events.ts";
export { RunMarkerView } from "./domain/run-marker/run-marker-view.value-object.ts";
export { SkipView } from "./domain/skip/skip-view.value-object.ts";
