// The services a flow, trigger or step can use. Chernabog provides each one;
// a team can replace any of them with its own layer, and tests can use fakes.

import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import type { AgentError, GitError, GitHubError, UsageError } from './errors.ts';
import type { Json } from './json.ts';

export const Labels = Schema.Struct({
  eligible: Schema.String,
  inProgress: Schema.String,
  needsReview: Schema.String,
  changesRequested: Schema.String,
  approved: Schema.String,
  needsHuman: Schema.String,
  needsClarification: Schema.String,
  stale: Schema.String,
});

export type Labels = typeof Labels.Type;

export const DEFAULT_LABELS: Labels = {
  eligible: 'auto:eligible',
  inProgress: 'auto:in-progress',
  needsReview: 'auto:needs-review',
  changesRequested: 'auto:changes-requested',
  approved: 'auto:approved',
  needsHuman: 'auto:needs-human',
  needsClarification: 'auto:needs-clarification',
  stale: 'auto:stale',
};

export const Board = Schema.Struct({ projectNumber: Schema.Finite, readyStatus: Schema.String, inProgressStatus: Schema.String });

export type Board = typeof Board.Type;

// configDir none is the agent's default home (~/.claude, ~/.codex).
// oauthTokenEnv names the environment variable holding a Claude login token
// (from `claude setup-token`), for a host with no login of its own, such as CI.
export const Account = Schema.Struct({
  name: Schema.String,
  configDir: Schema.Option(Schema.String),
  expectedEmail: Schema.Option(Schema.String),
  oauthTokenEnv: Schema.Option(Schema.String),
});

export type Account = typeof Account.Type;

export const Limits = Schema.Struct({
  // Agent attempts to get the local gate passing before a person takes over.
  localGateRounds: Schema.Finite,
  // Pushes to fix red CI before a person takes over.
  ciRounds: Schema.Finite,
  // Review rounds on one pull request before a person takes over.
  reviewRounds: Schema.Finite,
  // How long a pull request waits for its author's push before it is stale.
  staleAfter: Schema.Duration,
  // How long CI may stay pending before a person looks.
  ciTimeout: Schema.Duration,
});

export type Limits = typeof Limits.Type;

const Strings = Schema.Array(Schema.String);

// A launcher of your own, from machine config: command templates with
// {command}, {cwd}, {title} and {handle}.
export const LauncherCommands = Schema.Struct({ start: Strings, close: Strings, alive: Schema.Option(Strings), attach: Schema.Option(Strings) });

export type LauncherCommands = typeof LauncherCommands.Type;

// Where interactive agent sessions run (orca, tmux, a custom one, or headless
// for none), which config layer chose it, and a custom launcher's commands.
export const ResolvedLauncher = Schema.Struct({ name: Schema.String, from: Schema.String, custom: Schema.Option(LauncherCommands) });

export type ResolvedLauncher = typeof ResolvedLauncher.Type;

export const HEADLESS: ResolvedLauncher = { name: 'headless', from: 'default', custom: Option.none() };

// Everything a run knows about the repo it works on, merged from the repo's
// committed config, the person's override and machine config.
export const RepoSettings = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  path: Schema.String,
  baseBranch: Schema.String,
  account: Account,
  // The adapter that implements, and the account each adapter runs under.
  agent: Schema.String,
  agentAccounts: Schema.Record(Schema.String, Account),
  launcher: ResolvedLauncher,
  // The adapter a flow asked for in config (flows.<name>.agent), such as a Codex reviewer.
  flowAgents: Schema.Record(Schema.String, Schema.String),
  labels: Labels,
  install: Schema.Option(Schema.String),
  localGate: Strings,
  humanOnly: Strings,
  humanOnlyPaths: Strings,
  notes: Strings,
  board: Schema.Option(Board),
  reviewTrigger: Schema.Option(Schema.String),
  limits: Limits,
  // Extra environment for commands run in the repo, such as PATH with its pinned Node.
  env: Schema.Record(Schema.String, Schema.String),
  // The trusted copy of the repo's .chernabog/, read from the base branch.
  configDir: Schema.String,
});

export type RepoSettings = typeof RepoSettings.Type;

export class Repo extends Context.Service<Repo, RepoSettings>()('@chernabog/sdk/Repo') {}

// One thing a flow works on: an issue, a pull request. `key` identifies it
// across ticks, so it never has two runs at once. `signals` are events the
// trigger saw for it this tick, such as "pushed", which wake a waiting run.
export const WorkItem = Schema.Struct({
  key: Schema.String,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  data: Schema.Json,
  signals: Schema.optionalKey(Schema.Array(Schema.String)),
  // Only wakes a run already waiting on it; never starts one.
  wakeOnly: Schema.optionalKey(Schema.Boolean),
  // GitHub logins assigned to the item, and asked to review it, which
  // flows.<flow>.assignee and reviewRequested match to choose the machines it starts on.
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type WorkItem = typeof WorkItem.Type;

export const RunInfo = Schema.Struct({ flow: Schema.String, runId: Schema.String, executionId: Schema.String, item: WorkItem });

export type RunInfo = typeof RunInfo.Type;

export class Run extends Context.Service<Run, RunInfo>()('@chernabog/sdk/Run') {}

export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
};

export type Comment = { readonly id: number; readonly author: string; readonly body: string; readonly createdAt: string; readonly trusted: boolean };

// A review summary, or a comment on one line of the diff.
export type ReviewNote = Comment & { readonly location: Option.Option<{ readonly path: string; readonly line: number }> };

export type PullRequest = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly labels: ReadonlyArray<string>;
  readonly author: string;
  readonly assignees: ReadonlyArray<string>;
  // Users asked to review it who haven't yet; GitHub drops one once they review.
  readonly requestedReviewers: ReadonlyArray<string>;
};

export type ReviewComment = { readonly path: string; readonly line: number; readonly body: string };

export type NewPullRequest = { readonly head: string; readonly base: string; readonly title: string; readonly body: string };

export type NewReview = { readonly body: string; readonly commitSha: string; readonly comments: ReadonlyArray<ReviewComment> };

export type CiState = { state: 'pending'; waitingOn: Array<string> } | { state: 'green' } | { state: 'red'; failedChecks: Array<string> };

export class GitHub extends Context.Service<
  GitHub,
  {
    // Open issues labelled eligible (and ready on the board, when the repo has one), oldest first.
    readonly queuedIssues: Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    readonly oldestQueued: Effect.Effect<Option.Option<number>, GitHubError>;
    issue(number: number): Effect.Effect<Issue, GitHubError>;
    // Comments by the repo's owners, members and collaborators only; anyone can comment on a public repo.
    trustedComments(number: number): Effect.Effect<ReadonlyArray<Comment>, GitHubError>;
    comments(number: number): Effect.Effect<ReadonlyArray<Comment>, GitHubError>;
    comment(number: number, body: string): Effect.Effect<void, GitHubError>;
    addLabel(number: number, label: string): Effect.Effect<void, GitHubError>;
    removeLabel(number: number, label: string): Effect.Effect<void, GitHubError>;
    // Moves an issue to a Status on the repo's project board. Does nothing without a board.
    moveToStatus(number: number, status: string): Effect.Effect<void, GitHubError>;
    assignSelf(number: number): Effect.Effect<void, GitHubError>;
    readonly login: Effect.Effect<string, GitHubError>;
    branchSha(branch: string): Effect.Effect<Option.Option<string>, GitHubError>;
    // Whoever creates a branch first owns it: the claim.
    createBranch(branch: string, sha: string): Effect.Effect<'created' | 'already-exists', GitHubError>;
    deleteBranch(branch: string): Effect.Effect<void, GitHubError>;
    pullRequest(number: number): Effect.Effect<PullRequest, GitHubError>;
    pullRequestForBranch(branch: string): Effect.Effect<Option.Option<PullRequest>, GitHubError>;
    pullRequestsLabelled(label: string): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    openPullRequest(pullRequest: NewPullRequest): Effect.Effect<PullRequest, GitHubError>;
    ciState(pullRequest: number): Effect.Effect<CiState, GitHubError>;
    // Changed paths of a pull request, for path rules such as humanOnlyPaths.
    pullRequestFiles(pullRequest: number): Effect.Effect<ReadonlyArray<string>, GitHubError>;
    // Recently closed or merged pull requests carrying the label, newest first.
    closedPullRequestsLabelled(label: string): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    // Posts a review as a comment (an account cannot approve its own pull request; labels carry the verdict).
    review(pullRequest: number, review: NewReview): Effect.Effect<void, GitHubError>;
    // Review summaries and line comments on a pull request.
    reviewComments(pullRequest: number): Effect.Effect<ReadonlyArray<ReviewNote>, GitHubError>;
    // Any other call, for what the service does not cover.
    request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body: Option.Option<Json>): Effect.Effect<Json, GitHubError>;
  }
>()('@chernabog/sdk/GitHub') {}

export class Git extends Context.Service<
  Git,
  {
    run(args: ReadonlyArray<string>, cwd: string): Effect.Effect<string, GitError>;
    headSha(cwd: string): Effect.Effect<string, GitError>;
    // Commits on HEAD that origin/<base> does not have.
    commitsAhead(cwd: string, base: string): Effect.Effect<number, GitError>;
    changedFiles(cwd: string, base: string): Effect.Effect<ReadonlyArray<string>, GitError>;
    push(cwd: string, branch: string): Effect.Effect<void, GitError>;
    // Brings the checked-out branch up to its remote, fast-forward only.
    pull(cwd: string, branch: string): Effect.Effect<void, GitError>;
  }
>()('@chernabog/sdk/Git') {}

export class Worktree extends Context.Service<
  Worktree,
  {
    // The worktree for a branch, created from origin/<base> the first time and reused after.
    ensure(branch: string): Effect.Effect<string, GitError>;
    pathFor(branch: string): string;
    remove(branch: string): Effect.Effect<void, GitError>;
    // A detached worktree named `name`, reset to `ref` (fetched first) every call: for reading, such as a review.
    checkout(name: string, ref: string): Effect.Effect<string, GitError>;
  }
>()('@chernabog/sdk/Worktree') {}

export type LaunchDecision = { readonly launch: boolean; readonly reason: string };

export class Usage extends Context.Service<
  Usage,
  {
    // Whether the repo's account has room for one more task.
    readonly gate: Effect.Effect<LaunchDecision, UsageError>;
    // The account's logged-in identity; fails when it is not the expected one.
    readonly checkAccount: Effect.Effect<string, UsageError>;
  }
>()('@chernabog/sdk/Usage') {}

export type AgentResult = { readonly sessionId: string; readonly output: Json; readonly costUsd: Option.Option<number> };

export type AgentRequest = {
  readonly cwd: string;
  readonly prompt: string;
  // A stable id per piece of work, so a rerun after a crash resumes the same session.
  readonly sessionId: string;
  // Sent instead of `prompt` when the session already exists.
  readonly resumePrompt: Option.Option<string>;
  // JSON Schema the agent's final answer must match.
  readonly outputSchema: Option.Option<Json>;
  // Another adapter than the repo's own, such as a Codex reviewer.
  readonly adapter: Option.Option<string>;
};

export class Agent extends Context.Service<
  Agent,
  {
    run(request: AgentRequest): Effect.Effect<AgentResult, AgentError>;
    readonly adapters: ReadonlyArray<string>;
  }
>()('@chernabog/sdk/Agent') {}

// Writes to the run's log file, which `chernabog logs <run>` prints.
export class RunLog extends Context.Service<
  RunLog,
  {
    log(line: string): Effect.Effect<void>;
    step(name: string): Effect.Effect<void>;
    stepDone(name: string): Effect.Effect<void>;
  }
>()('@chernabog/sdk/RunLog') {}
