// What the daemon and its clients (the CLI, the TUI, the dashboard) say over
// the local socket. Every side decodes with these schemas. The dashboard
// bundles this file for a browser, so it names effect and the modules'
// <module>.contracts.ts, whose value objects and events reach no adapter,
// and nothing else.

import * as Schema from "effect/Schema";

import {
  RepoEnrolled,
  RepoPaused,
  RepoResumed,
  RepoUnenrolled,
} from "../../modules/enrollment/enrollment.contracts.ts";
import {
  ActiveRun,
  CancelTarget,
  HoldView,
  PullRequestOpened,
  RunEnteredStep,
  RunFinished,
  RunHistory,
  RunMarkersReleased,
  RunMarkerView,
  RunNeedsAttention,
  RunStarted,
  RunView,
  SkipView,
} from "../../modules/runs/runs.contracts.ts";
import { RepoTrusted } from "../../modules/trust/trust.contracts.ts";

const Maybe = Schema.OptionFromNullOr(Schema.String);

export const FlowStatus = Schema.Struct({
  name: Schema.String,
  // The GitHub persona it runs as; absent for the implicit one.
  persona: Schema.optionalKey(Schema.String),
  // Its cron expression; for a manual flow, how a person starts it.
  schedule: Schema.String,
  // Whether it has no trigger, so it runs only when a person names its work.
  manual: Schema.optionalKey(Schema.Boolean),
  // The schedule the team gives it, and the persona's own over it, if any.
  teamSchedule: Schema.optionalKey(Schema.String),
  ownSchedule: Schema.optionalKey(Schema.String),
  next: Maybe,
  lastTick: Maybe,
  // What made the last tick: cron, manual, or an event such as
  // "local: #73 review requested" or "notification: review_requested on #73".
  lastCause: Schema.optionalKey(Schema.String),
  // The event a tick is due for, while it waits to run.
  pending: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  // Why it doesn't run on this machine, when it doesn't.
  offReason: Schema.optionalKey(Schema.String),
  // What the last tick found waiting for a run.
  queued: Schema.Array(Schema.String),
  // What its trigger left for other personas or machines, each with why.
  assignedElsewhere: Schema.optionalKey(Schema.Array(Schema.String)),
  // What its trigger says waits on someone, each with who and why, such as
  // "pr-73 waits on bob (not on this machine)".
  waiting: Schema.optionalKey(Schema.Array(Schema.String)),
  // Whether it is the flow `chernabog start <issue>` runs, as it declares.
  start: Schema.optionalKey(Schema.Boolean),
  // For a flow imported from a recipe package, the package and its version,
  // as `@acme/recipes@2.1.0`; absent for a flow in the repo.
  source: Schema.optionalKey(Schema.String),
});

// The accounts a persona spends in a repo: the one its runs use, and its own
// pick of it and of each role's, if any; none falls back to the default.
export const PersonaStatus = Schema.Struct({
  persona: Schema.optionalKey(Schema.String),
  account: Schema.String,
  ownAccount: Maybe,
  roles: Schema.Array(Schema.Struct({ role: Schema.String, account: Maybe })),
});

export type PersonaStatus = typeof PersonaStatus.Type;

export const RepoStatus = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  status: Schema.Literals(["ready", "untrusted", "error", "missing", "incompatible"]),
  message: Maybe,
  paused: Schema.Boolean,
  enabled: Schema.Boolean,
  tree: Maybe,
  // Where its interactive agent sessions run, and which config layer chose it.
  launcher: Maybe,
  flows: Schema.Array(FlowStatus),
  personas: Schema.optionalKey(Schema.Array(PersonaStatus)),
});

export type RepoStatus = typeof RepoStatus.Type;

export const DaemonStatus = Schema.Struct({
  pid: Schema.Finite,
  startedAt: Schema.String,
  busy: Schema.Finite,
  reloadPending: Schema.Boolean,
  // Draining to restart on an upgraded chernabog: starting no new runs. Absent
  // from a daemon from before it could.
  draining: Schema.optionalKey(Schema.Boolean),
  repos: Schema.Array(RepoStatus),
  // The accounts in machine config, for choosing one.
  accounts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
  ),
  active: Schema.Array(ActiveRun),
  recent: Schema.Array(RunView),
  skips: Schema.Array(SkipView),
  // The items flows' triggers hold, and why, as each flow's latest tick found
  // them. Absent from a daemon from before holds.
  holds: Schema.optionalKey(Schema.Array(HoldView)),
  // Each persona whose GitHub notifications tick its flows, and why its poll
  // fails, with the fix, if it does. Absent from a daemon from before them.
  notifications: Schema.optionalKey(
    Schema.Array(Schema.Struct({ persona: Schema.optionalKey(Schema.String), problem: Maybe })),
  ),
  // Each run in flight whose stillValid check keeps failing: how many times
  // in a row, and the last failure. The run carries on. Absent from a daemon
  // from before the checks.
  validity: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ runId: Schema.String, failures: Schema.Finite, problem: Schema.String }),
    ),
  ),
  // The lease on each claim a run in flight holds, as its last check or
  // renewal found it: when it runs out and was last renewed, and, when the
  // last renewal failed, why: the lease is at risk. Absent from a daemon from
  // before leases.
  leases: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        runId: Schema.String,
        item: Schema.String,
        expiresAt: Maybe,
        renewedAt: Maybe,
        atRisk: Maybe,
      }),
    ),
  ),
  // What ended runs left on their items: markers whose release is pending or
  // keeps failing, and ones no flow defines a release for any more, for a
  // person. Absent from a daemon from before markers.
  markers: Schema.optionalKey(Schema.Array(RunMarkerView)),
});

export type DaemonStatus = typeof DaemonStatus.Type;

// `persona` picks one, for a flow that runs as several.
export const RunRequest = Schema.Struct({
  repo: Schema.String,
  flow: Schema.String,
  item: Schema.OptionFromNullOr(Schema.String),
  persona: Schema.optionalKey(Schema.String),
});

export type RunRequest = typeof RunRequest.Type;

export const TickResult = Schema.Struct({ started: Schema.Array(Schema.String), skipped: Maybe });

export type TickResult = typeof TickResult.Type;

export const Reloaded = Schema.Struct({ reloadPending: Schema.Boolean });

// Why the daemon refused a request. A command it dispatched that failed also
// carries its error's tag and the error itself, encoded with the command's own
// failure schema, for the client to fail with the error the command declares.
export const Refusal = Schema.Struct({
  error: Schema.String,
  tag: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(Schema.Unknown),
});

export type Refusal = typeof Refusal.Type;

export const RunReply = Schema.OptionFromNullOr(RunView);

// GET /runs/:id/history: the steps a run entered and the signals it waits on.
// And the events about one run that the dashboard's page of it listens for.
export { RunEnteredStep, RunFinished, RunHistory, RunNeedsAttention };

// POST /dashboard/start: the port to open the dashboard's 127.0.0.1 listener
// on; without one, the last one asked for, else 4848.
export const DashboardStart = Schema.Struct({
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
});

export type DashboardStart = typeof DashboardStart.Type;

// What GET /dashboard and the routes that start, stop and rotate it answer:
// whether the listener is open, its port (the last one asked for, when it
// isn't), and the URL with the token that opens it in a browser.
export const DashboardState = Schema.Struct({
  running: Schema.Boolean,
  port: Schema.Int,
  url: Schema.String,
});

export type DashboardState = typeof DashboardState.Type;

// A person cancelling a run in flight: which, who they are, and whether to
// close the agent sessions it left open.
export const CancelRequest = Schema.Struct({
  target: CancelTarget,
  by: Schema.String,
  closeSessions: Schema.Boolean,
});

export type CancelRequest = typeof CancelRequest.Type;

// What the daemon itself says on the /events stream, beside the modules'
// events. Each carries an eventId of its own, as theirs do.

// The daemon will restart: a reload is pending (it restarts once nothing is
// executing), or it is draining to restart on an upgraded chernabog (it starts
// no new runs meanwhile).
export const DaemonReloading = Schema.TaggedStruct("DaemonReloading", {
  eventId: Schema.String,
  reason: Schema.Literals(["reload-pending", "draining"]),
  at: Schema.String,
});

export type DaemonReloading = typeof DaemonReloading.Type;

// A persona's flow ticked: the runs it started, why it started nothing more,
// if it says, and what its trigger found waiting.
export const TickRan = Schema.TaggedStruct("TickRan", {
  eventId: Schema.String,
  repo: Schema.String,
  flow: Schema.String,
  persona: Schema.Option(Schema.String),
  cause: Schema.String,
  started: Schema.Array(Schema.String),
  skipped: Schema.Option(Schema.String),
  queued: Schema.Array(Schema.String),
  at: Schema.String,
});

export type TickRan = typeof TickRan.Type;

// Something the daemon's bus can't hear changed what /status answers: a
// person edited machine config, paused.json or trust.json by hand, or
// another process (a foreground `chernabog run --from-checkout`, a rehearsal)
// wrote to state.db. A client asks /status again.
export const StatusChanged = Schema.TaggedStruct("StatusChanged", {
  eventId: Schema.String,
  // The files under the chernabog home that changed, such as config.yaml.
  files: Schema.Array(Schema.String),
  at: Schema.String,
});

export type StatusChanged = typeof StatusChanged.Type;

// What the dashboard's /events stream sends after its snapshot: what happened
// to a run, as the runs' commands dispatch it; to an enrolled repo, as
// enrollment's and trust's do; and what the daemon says itself. A resumed run
// can say one again, under the same eventId, for a client to drop.
export const DaemonEvent = Schema.Union([
  RunStarted.schema,
  RunEnteredStep.schema,
  RunNeedsAttention.schema,
  RunFinished.schema,
  PullRequestOpened.schema,
  RunMarkersReleased.schema,
  RepoEnrolled,
  RepoPaused,
  RepoResumed,
  RepoUnenrolled,
  RepoTrusted,
  DaemonReloading,
  TickRan,
  StatusChanged,
]);

export type DaemonEvent = typeof DaemonEvent.Type;

// The tag of each event the /events stream sends, which it subscribes to:
// every member of DaemonEvent, as the compiler checks.
const sent = {
  RunStarted: true,
  RunEnteredStep: true,
  RunNeedsAttention: true,
  RunFinished: true,
  PullRequestOpened: true,
  RunMarkersReleased: true,
  RepoEnrolled: true,
  RepoPaused: true,
  RepoResumed: true,
  RepoUnenrolled: true,
  RepoTrusted: true,
  DaemonReloading: true,
  TickRan: true,
  StatusChanged: true,
} satisfies { readonly [Tag in DaemonEvent["_tag"]]: true };

export const daemonEventTags: ReadonlyArray<string> = Object.keys(sent);
