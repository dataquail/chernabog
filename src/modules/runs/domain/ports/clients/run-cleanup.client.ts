import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type AgentSessionOpened } from "../../run/agent-session-opened.value-object.ts";
import { type CleanupFailed } from "../../run/run.errors.ts";
import { type RunRoot } from "../../run/run.root.ts";

// A worktree cleaning up left in place, and why: work a person may want.
export type KeptWorktree = { readonly path: string; readonly reason: string };

export type WorktreeCleanup = {
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<KeptWorktree>;
};

// A run's claim on its issue, released: its claim ref and assignment are
// gone, and its branch is deleted unless it holds work, which `kept` says.
// Labels the run put on the issue are the flow's, which its markers release.
export type ReleasedClaim = {
  readonly branch: string;
  readonly kept: Option.Option<string>;
};

// An agent session a run opened that is still open, under its launcher, and
// whether a person works in it.
export type OpenSession = {
  readonly sessionId: string;
  readonly launcher: string;
  readonly handle: string;
  readonly withPerson: boolean;
};

// A container chernabog labelled with a run's id (ADR 24, decision 9), under
// the runtime it runs in: its session's, if it names one, and whether that
// session's `__launch` still runs, which removes the container itself as it
// exits.
export type LabelledContainer = {
  readonly runtime: string;
  readonly id: string;
  readonly runId: string;
  readonly sessionId: Option.Option<string>;
  readonly launched: boolean;
};

// What a run holds outside state.db, for cancelling it as a run that finishes
// would leave things: its worktrees, its claim ref, its claim on its issue,
// its agent sessions and their containers. Each acts as the run's persona,
// and never touches a pull request.
export type RunCleanupClientService = {
  // Removes the run's worktrees for its item, keeping any with work not pushed.
  readonly removeWorktrees: (run: RunRoot) => Effect.Effect<WorktreeCleanup, CleanupFailed>;
  // Deletes the claim ref on `claim` (`issue-<n>`, `pr-<n>`) when it names
  // the run, and says which ref it deleted; none when another run holds it,
  // or nobody does.
  readonly releaseClaimRef: (
    run: RunRoot,
    claim: string,
  ) => Effect.Effect<Option.Option<string>, CleanupFailed>;
  // Releases the run's claim on the issue its item is; none when the issue's
  // latest claim isn't the run's, which leaves it alone.
  readonly releaseClaim: (
    run: RunRoot,
    issue: number,
  ) => Effect.Effect<Option.Option<ReleasedClaim>, CleanupFailed>;
  // The agent sessions the run opened that are still open.
  readonly openSessions: (run: RunRoot) => Effect.Effect<ReadonlyArray<OpenSession>>;
  // Those of the sessions a run's spoke reported opening that are still open,
  // by the launch record each reported: a headless session, which keeps
  // none, died with its spoke's process group.
  readonly openReported: (
    sessions: ReadonlyArray<AgentSessionOpened>,
  ) => Effect.Effect<ReadonlyArray<OpenSession>>;
  // Closes a session through its launcher, by the handle it recorded.
  readonly closeSession: (session: OpenSession) => Effect.Effect<void, CleanupFailed>;
  // Removes the run's containers, by its label on the runtime its repo's
  // sandbox names, never by name, except those of the sessions `sparing`
  // names: the containers removed. None for a repo without a sandbox.
  readonly removeContainers: (
    run: RunRoot,
    sparing: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<LabelledContainer>, CleanupFailed>;
  // The container runtimes the sandboxes of the repos this process loaded name.
  readonly containerRuntimes: Effect.Effect<ReadonlyArray<string>>;
  // Every container on `runtime` labelled with a run's id.
  readonly labelledContainers: (
    runtime: string,
  ) => Effect.Effect<ReadonlyArray<LabelledContainer>, CleanupFailed>;
  // Removes one of them, by its id.
  readonly removeContainer: (container: LabelledContainer) => Effect.Effect<void, CleanupFailed>;
};

export class RunCleanupClient extends Context.Service<RunCleanupClient, RunCleanupClientService>()(
  "RunCleanupClient",
) {}
