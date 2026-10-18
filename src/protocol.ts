// What the daemon and its clients (the CLI, the TUI) say over the local
// socket. Both sides decode with these schemas.

import * as Schema from 'effect/Schema';

import { RunRow, SkipRow } from './state.ts';

const Maybe = Schema.OptionFromNullOr(Schema.String);

export const FlowStatus = Schema.Struct({
  name: Schema.String,
  schedule: Schema.String,
  next: Maybe,
  lastTick: Maybe,
  enabled: Schema.Boolean,
  // What the last tick found waiting for a run.
  queued: Schema.Array(Schema.String),
});

export const RepoStatus = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  status: Schema.Literals(['ready', 'untrusted', 'error']),
  message: Maybe,
  paused: Schema.Boolean,
  enabled: Schema.Boolean,
  tree: Maybe,
  // Where its interactive agent sessions run, and which config layer chose it.
  launcher: Maybe,
  flows: Schema.Array(FlowStatus),
});

export type RepoStatus = typeof RepoStatus.Type;

export const ActiveRun = Schema.Struct({ ...RunRow.fields, parked: Schema.Boolean });

export const DaemonStatus = Schema.Struct({
  pid: Schema.Finite,
  startedAt: Schema.String,
  busy: Schema.Finite,
  reloadPending: Schema.Boolean,
  repos: Schema.Array(RepoStatus),
  active: Schema.Array(ActiveRun),
  recent: Schema.Array(RunRow),
  skips: Schema.Array(SkipRow),
});

export type DaemonStatus = typeof DaemonStatus.Type;

export const RunRequest = Schema.Struct({ repo: Schema.String, flow: Schema.String, item: Schema.OptionFromNullOr(Schema.String) });

export type RunRequest = typeof RunRequest.Type;

export const TickResult = Schema.Struct({ started: Schema.Array(Schema.String), skipped: Maybe });

export type TickResult = typeof TickResult.Type;

export const Reloaded = Schema.Struct({ reloadPending: Schema.Boolean });

export const Refusal = Schema.Struct({ error: Schema.String });

export const RunReply = Schema.OptionFromNullOr(RunRow);
