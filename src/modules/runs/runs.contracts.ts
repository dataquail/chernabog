// The contracts surface: the value objects and events the daemon's protocol
// carries over JSON (src/interface/daemon/daemon.protocol.ts), re-exported
// from the domain alone. The dashboard decodes with the protocol in a
// browser, so nothing reached from here may name an adapter, the platform or
// Bun's runtime; runs.platform.ts, which publishes the engine, would.

export { HoldView } from "./domain/holds/hold-view.value-object.ts";
export { CancelTarget } from "./domain/run/cancelled-run.value-object.ts";
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
export { RunMarkerView } from "./domain/run-marker/run-marker-view.value-object.ts";
export { SkipView } from "./domain/skip/skip-view.value-object.ts";
