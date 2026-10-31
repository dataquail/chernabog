// What the daemon and its clients (the CLI, the TUI, the dashboard) say over
// the local socket. Every side decodes with these schemas. The dashboard
// bundles this file for a browser, so it names effect and the modules'
// <module>.contracts.ts, whose value objects and events reach no adapter,
// and nothing else.

import * as Schema from "effect/Schema";

import {
  ActiveRun,
  CancelTarget,
  HoldView,
  PullRequestOpened,
  RunEnteredStep,
  RunFinished,
  RunMarkerView,
  RunNeedsAttention,
  RunStarted,
  RunView,
  SkipView,
} from "../../modules/runs/runs.contracts.ts";

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

// A person cancelling a run in flight: which, who they are, and whether to
// close the agent sessions it left open.
export const CancelRequest = Schema.Struct({
  target: CancelTarget,
  by: Schema.String,
  closeSessions: Schema.Boolean,
});

export type CancelRequest = typeof CancelRequest.Type;

// What the dashboard's /events stream sends: what happened to a run, as the
// runs' commands dispatch it. A resumed run can say one again, under the same
// eventId, for a client to drop.
export const DaemonEvent = Schema.Union([
  RunStarted.schema,
  RunEnteredStep.schema,
  RunNeedsAttention.schema,
  RunFinished.schema,
  PullRequestOpened.schema,
]);

export type DaemonEvent = typeof DaemonEvent.Type;
