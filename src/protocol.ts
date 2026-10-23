// What the daemon and its clients (the CLI, the TUI) say over the local
// socket. Both sides decode with these schemas.

import * as Schema from "effect/Schema";

import { ActiveRun, RunView } from "./modules/runs/use-cases/run.result.ts";
import { SkipView } from "./modules/runs/use-cases/skip.result.ts";

const Maybe = Schema.OptionFromNullOr(Schema.String);

export const FlowStatus = Schema.Struct({
  name: Schema.String,
  // The GitHub persona it runs as; absent for the implicit one.
  persona: Schema.optionalKey(Schema.String),
  schedule: Schema.String,
  // The schedule the team gives it, and the persona's own over it, if any.
  teamSchedule: Schema.optionalKey(Schema.String),
  ownSchedule: Schema.optionalKey(Schema.String),
  next: Maybe,
  lastTick: Maybe,
  enabled: Schema.Boolean,
  // Why it doesn't run on this machine, when it doesn't.
  offReason: Schema.optionalKey(Schema.String),
  // What the last tick found waiting for a run.
  queued: Schema.Array(Schema.String),
  // What it left for other machines, by flows.<flow>.assignee and reviewRequested.
  assignedElsewhere: Schema.optionalKey(Schema.Array(Schema.String)),
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
  status: Schema.Literals(["ready", "untrusted", "error", "missing"]),
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
  repos: Schema.Array(RepoStatus),
  // The accounts in machine config, for choosing one.
  accounts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
  ),
  active: Schema.Array(ActiveRun),
  recent: Schema.Array(RunView),
  skips: Schema.Array(SkipView),
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

export const Refusal = Schema.Struct({ error: Schema.String });

export const RunReply = Schema.OptionFromNullOr(RunView);
