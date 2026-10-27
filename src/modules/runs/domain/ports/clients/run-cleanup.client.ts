import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type CleanupFailed } from "../../run/run.errors.ts";
import { type RunRoot } from "../../run/run.root.ts";

// A worktree cleaning up left in place, and why: work a person may want.
export type KeptWorktree = { readonly path: string; readonly reason: string };

export type WorktreeCleanup = {
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<KeptWorktree>;
};

// A run's claim on its issue, released: its claim ref, the claim label and
// assignment are gone, and its branch is deleted unless it holds work, which
// `kept` says.
export type ReleasedClaim = {
  readonly branch: string;
  readonly kept: Option.Option<string>;
};

// An agent session a run opened that is still open, under its launcher.
export type OpenSession = {
  readonly sessionId: string;
  readonly launcher: string;
  readonly handle: string;
};

// What a run holds outside state.db, for cancelling it as a run that finishes
// would leave things: its worktrees, its claim on its issue, and its agent
// sessions. Each acts as the run's persona, and never touches a pull request.
export type RunCleanupClientService = {
  // Removes the run's worktrees for its item, keeping any with work not pushed.
  readonly removeWorktrees: (run: RunRoot) => Effect.Effect<WorktreeCleanup, CleanupFailed>;
  // Releases the run's claim on the issue its item is; none when the issue's
  // latest claim isn't the run's, which leaves it alone.
  readonly releaseClaim: (
    run: RunRoot,
    issue: number,
  ) => Effect.Effect<Option.Option<ReleasedClaim>, CleanupFailed>;
  // The agent sessions the run opened that are still open.
  readonly openSessions: (run: RunRoot) => Effect.Effect<ReadonlyArray<OpenSession>>;
  // Closes a session through its launcher, by the handle it recorded.
  readonly closeSession: (session: OpenSession) => Effect.Effect<void, CleanupFailed>;
};

export class RunCleanupClient extends Context.Service<RunCleanupClient, RunCleanupClientService>()(
  "RunCleanupClient",
) {}
