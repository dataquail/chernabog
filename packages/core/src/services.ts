// The services a flow, trigger or step can use. Chernabog provides each one;
// a team can replace any of them with its own layer, and tests can use fakes.

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  AgentError,
  GitError,
  GitHubError,
  MergeRefused,
  NotFound,
  PullRequestClosed,
  PushRejected,
  UsageError,
} from "./errors.ts";
import type { Json } from "./json.ts";

export const Labels = Schema.Struct({
  eligible: Schema.String,
  inProgress: Schema.String,
  needsReview: Schema.String,
  changesRequested: Schema.String,
  approved: Schema.String,
  needsHuman: Schema.String,
  needsClarification: Schema.String,
  stale: Schema.String,
  // The automated path: chernabog merges a pull request only when it carries this.
  ship: Schema.String,
  // The hybrid path, for people reading GitHub: a person started the work. No flow decides anything from it.
  hybrid: Schema.String,
});

export type Labels = typeof Labels.Type;

export const DEFAULT_LABELS: Labels = {
  eligible: "auto:eligible",
  inProgress: "auto:in-progress",
  needsReview: "auto:needs-review",
  changesRequested: "auto:changes-requested",
  approved: "auto:approved",
  needsHuman: "auto:needs-human",
  needsClarification: "auto:needs-clarification",
  stale: "auto:stale",
  ship: "auto:ship",
  hybrid: "hybrid",
};

export const Board = Schema.Struct({
  projectNumber: Schema.Finite,
  readyStatus: Schema.String,
  inProgressStatus: Schema.String,
});

export type Board = typeof Board.Type;

// configDir none is the agent's default home (~/.claude, ~/.codex).
// oauthTokenEnv names the environment variable holding a Claude login token
// (from `claude setup-token`), for a host with no login of its own, such as CI.
// usageGate none launches without reading usage, which such a token cannot.
export const UsageGateMode = Schema.Literals(["usage", "none"]);

export type UsageGateMode = typeof UsageGateMode.Type;

export const Account = Schema.Struct({
  name: Schema.String,
  configDir: Schema.Option(Schema.String),
  expectedEmail: Schema.Option(Schema.String),
  oauthTokenEnv: Schema.Option(Schema.String),
  usageGate: UsageGateMode,
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
  // The most tasks one plan may hold, its verify node aside.
  planNodes: Schema.Finite,
  // Times the agent is asked to fix a plan that fails its checks before a person takes over.
  planRounds: Schema.Finite,
  // The most layers one stack may hold before the run stops starting new ones
  // and waits for the bottom to merge.
  stackDepth: Schema.Finite,
  // How long a merge commit may go without any CI run starting before the
  // post-merge recipe takes the repo to run no CI for it.
  postMergeNoCiGrace: Schema.Duration,
});

export type Limits = typeof Limits.Type;

const Strings = Schema.Array(Schema.String);

// A launcher of your own, from machine config: command templates with
// {command}, {cwd}, {title} and {handle}.
export const LauncherCommands = Schema.Struct({
  start: Strings,
  close: Strings,
  alive: Schema.Option(Strings),
  attach: Schema.Option(Strings),
});

export type LauncherCommands = typeof LauncherCommands.Type;

// Where interactive agent sessions run (orca, tmux, a custom one, or headless
// for none), which config layer chose it, and a custom launcher's commands.
export const ResolvedLauncher = Schema.Struct({
  name: Schema.String,
  from: Schema.String,
  custom: Schema.Option(LauncherCommands),
});

export type ResolvedLauncher = typeof ResolvedLauncher.Type;

export const HEADLESS: ResolvedLauncher = {
  name: "headless",
  from: "default",
  custom: Option.none(),
};

// Everything a run knows about the repo it works on, merged from the repo's
// committed config and the persona's settings in machine config.
export const RepoSettings = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  path: Schema.String,
  baseBranch: Schema.String,
  // The team's reviewer pool, by GitHub login: a pull request with green CI
  // gets one of them, never its author. None, when the team names no pool.
  reviewers: Schema.optionalKey(Strings),
  // The GitHub login this run acts as, when machine config names personas;
  // absent, it acts as whoever the daemon is.
  persona: Schema.optionalKey(Schema.String),
  account: Account,
  // The adapter that implements, and the account each adapter runs under.
  agent: Schema.String,
  agentAccounts: Schema.Record(Schema.String, Account),
  launcher: ResolvedLauncher,
  // The adapter a flow asked for in config (flows.<name>.agent), such as a Codex reviewer.
  flowAgents: Schema.Record(Schema.String, Schema.String),
  // The adapters a flow gave its roles in config (flows.<name>.agents), such as { reviewer: codex }.
  flowRoleAgents: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
  // The adapters a persona's own role picks run with, in every flow: the
  // agent of the account it chose for the role (roles: { reviewer: codex-work }).
  roleAgents: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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

export class Repo extends Context.Service<Repo, RepoSettings>()("@chernabog/sdk/Repo") {}

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
  // Why the trigger won't start it yet, such as "waits on #12, #13": it starts
  // no run, even with wakeOnly unset, and `chernabog status` shows the reason.
  // Its signals still wake a run waiting on it.
  held: Schema.optionalKey(Schema.String),
  // GitHub logins assigned to the item, and asked to review it, which
  // flows.<flow>.assignee and reviewRequested match to choose the machines it starts on.
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type WorkItem = typeof WorkItem.Type;

export const RunInfo = Schema.Struct({
  flow: Schema.String,
  runId: Schema.String,
  executionId: Schema.String,
  item: WorkItem,
  // The pull request the run opened or adopted for its item, as far as the
  // engine knows; given to a flow's stillValid, absent anywhere else.
  pullRequest: Schema.optionalKey(Schema.Finite),
  // How long a claim the run makes lasts, in milliseconds, until the daemon
  // renews it: the team's limits.leaseTtl. Claims' default when absent.
  leaseTtl: Schema.optionalKey(Schema.Finite),
});

export type RunInfo = typeof RunInfo.Type;

export class Run extends Context.Service<Run, RunInfo>()("@chernabog/sdk/Run") {}

// The recipe package a run's flow is imported from (config.yaml's
// flows.<name>.from): its name, version, and the directory it's installed in.
// Its prompts and steps are looked up there after the repo's own, so a repo can
// override one of them without copying the flow. A flow copied into the repo,
// or written there, has none.
export type FlowPackageInfo = {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
};

export class FlowPackage extends Context.Service<FlowPackage, FlowPackageInfo>()(
  "@chernabog/sdk/FlowPackage",
) {}

export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  // Whether it is open; absent from a GitHub that doesn't say, which is taken as open.
  readonly state?: "open" | "closed";
};

// An issue as GitHub lists it under another: a sub-issue, or a blocker.
export type LinkedIssue = Issue & { readonly state: "open" | "closed" };

export type NewIssue = {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
};

export type Comment = {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly trusted: boolean;
};

// A review summary, or a comment on one line of the diff.
export type ReviewNote = Comment & {
  readonly location: Option.Option<{ readonly path: string; readonly line: number }>;
};

export type PullRequest = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
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

export type NewPullRequest = {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
};

// A review approves, requests changes, or only comments, which is the default.
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type NewReview = {
  readonly body: string;
  readonly commitSha: string;
  readonly comments: ReadonlyArray<ReviewComment>;
  readonly event?: ReviewEvent;
};

// A review someone submitted: who, its state as GitHub gives it (APPROVED,
// CHANGES_REQUESTED, COMMENTED, DISMISSED), and the head it saw.
export type SubmittedReview = {
  readonly author: string;
  readonly state: string;
  readonly commitSha: string;
};

export type NewCommit = {
  readonly message: string;
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
};

export type RefCommit = { readonly sha: string; readonly message: string };

export type MergeMethod = "merge" | "squash" | "rebase";

// The merge of exactly `sha`: GitHub refuses one whose head has moved since.
export type MergeRequest = { readonly method: MergeMethod; readonly sha: string };

// The merge commit.
export type Merged = { readonly sha: string };

export type CiState = (
  | { state: "pending"; waitingOn: Array<string> }
  | { state: "green" }
  | { state: "red"; failedChecks: Array<string> }
) & {
  // Why the reading counts every check rather than the required ones, when
  // GitHub refused to say which those are, as it does for a private repo in a
  // free-plan org.
  readonly caveat?: string;
};

// A failed check, and where to read why.
export type CiFailedRun = {
  readonly name: string;
  readonly url: string;
  // The Actions job, for a check run Actions made.
  readonly job: Option.Option<number>;
  // The Actions workflow run, for a branch's reading, which is by workflow.
  readonly workflowRun: Option.Option<number>;
};

// A commit's or a branch's CI, with the runs that failed.
export type CiReport = CiState & { readonly failedRuns: ReadonlyArray<CiFailedRun> };

export type CiFailureDetails = {
  readonly url: string;
  // The end of each failed job's log; none for a check with no log on GitHub,
  // such as a commit status from another CI, or a log GitHub no longer keeps.
  readonly logTail: Option.Option<string>;
};

export type CommitCiOptions = {
  // Only Actions workflow runs triggered by this event count, such as "push",
  // so runs that merely share the sha (Dependabot's) don't decide it.
  readonly event?: string;
};

export class GitHub extends Context.Service<
  GitHub,
  {
    // Open issues labelled eligible (and ready on the board, when the repo has one), oldest first.
    readonly queuedIssues: Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    // Open issues with this label (and ready on the board, when the repo has one), oldest first.
    queuedIssuesLabelled(label: string): Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    readonly oldestQueued: Effect.Effect<Option.Option<number>, GitHubError>;
    // Open issues with this label, whatever their status on the board, oldest first.
    issuesLabelled(label: string): Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    issue(number: number): Effect.Effect<Issue, NotFound | GitHubError>;
    createIssue(issue: NewIssue): Effect.Effect<Issue, GitHubError>;
    // An epic's tasks, open and closed, in GitHub's order.
    subIssues(parent: number): Effect.Effect<ReadonlyArray<LinkedIssue>, GitHubError>;
    // Makes `child` a sub-issue of `parent`; one already there stays.
    addSubIssue(parent: number, child: number): Effect.Effect<void, GitHubError>;
    // The issues that must close before this one can start, open and closed.
    blockedBy(issue: number): Effect.Effect<ReadonlyArray<LinkedIssue>, GitHubError>;
    // Records that `blocker` blocks `issue`; a link already there stays.
    addBlockedBy(issue: number, blocker: number): Effect.Effect<void, GitHubError>;
    // Removing a link that isn't there is not an error.
    removeBlockedBy(issue: number, blocker: number): Effect.Effect<void, GitHubError>;
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
    createBranch(
      branch: string,
      sha: string,
    ): Effect.Effect<"created" | "already-exists", GitHubError>;
    deleteBranch(branch: string): Effect.Effect<void, GitHubError>;
    // A commit made through the API, with no worktree: its sha.
    createCommit(commit: NewCommit): Effect.Effect<string, GitHubError>;
    // Any ref, named in full (`refs/chernabog/claims/issue-12`). Whoever creates one first holds it.
    createRef(ref: string, sha: string): Effect.Effect<"created" | "already-exists", GitHubError>;
    // The commit a ref points at, with its message; none for a ref GitHub doesn't have.
    ref(ref: string): Effect.Effect<Option.Option<RefCommit>, GitHubError>;
    // Deleting a ref GitHub doesn't have is not an error.
    deleteRef(ref: string): Effect.Effect<void, GitHubError>;
    // Points a ref GitHub has at `sha`, forced: GitHub checks nothing for refs
    // outside refs/heads/, so this is not a compare-and-swap.
    updateRef(ref: string, sha: string): Effect.Effect<void, GitHubError>;
    pullRequest(number: number): Effect.Effect<PullRequest, NotFound | GitHubError>;
    pullRequestForBranch(branch: string): Effect.Effect<Option.Option<PullRequest>, GitHubError>;
    pullRequestsLabelled(label: string): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    readonly openPullRequests: Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    // Asks these logins to review the pull request, or to review it again.
    requestReviewers(
      pullRequest: number,
      logins: ReadonlyArray<string>,
    ): Effect.Effect<void, PullRequestClosed | GitHubError>;
    // The reviews submitted on a pull request, oldest first.
    reviews(pullRequest: number): Effect.Effect<ReadonlyArray<SubmittedReview>, GitHubError>;
    openPullRequest(pullRequest: NewPullRequest): Effect.Effect<PullRequest, GitHubError>;
    // Red as soon as any check fails; green once every check the base branch
    // requires has passed, or every check, when the branch requires none or
    // GitHub won't say (then `caveat` says so).
    ciState(pullRequest: number): Effect.Effect<CiState, GitHubError>;
    // A commit's check runs and commit statuses. A sha with none yet, such as
    // just after a push, is pending with nothing in waitingOn: telling "no CI
    // yet" from "no CI" is up to the flow.
    commitCiState(sha: string, options?: CommitCiOptions): Effect.Effect<CiReport, GitHubError>;
    // For each Actions workflow, its newest completed push run on the branch
    // (a cancelled one decides nothing): red if any failed. A run still in
    // progress changes nothing; a workflow with no completed run is waited on.
    branchCiState(branch: string): Effect.Effect<CiReport, GitHubError>;
    // A failed run's link and the tail of its failing log.
    ciFailureDetails(run: CiFailedRun): Effect.Effect<CiFailureDetails, GitHubError>;
    // Changed paths of a pull request, for path rules such as humanOnlyPaths.
    pullRequestFiles(pullRequest: number): Effect.Effect<ReadonlyArray<string>, GitHubError>;
    // Recently closed or merged pull requests carrying the label, newest first.
    closedPullRequestsLabelled(
      label: string,
    ): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    // Posts a review. GitHub won't let an account approve or request changes on
    // its own pull request; such a review is posted as a comment instead.
    review(
      pullRequest: number,
      review: NewReview,
    ): Effect.Effect<void, PullRequestClosed | GitHubError>;
    // Review summaries and line comments on a pull request.
    reviewComments(pullRequest: number): Effect.Effect<ReadonlyArray<ReviewNote>, GitHubError>;
    // Refused by GitHub (branch protection, a conflict, a moved head) with its reason.
    merge(
      pullRequest: number,
      merge: MergeRequest,
    ): Effect.Effect<Merged, MergeRefused | PullRequestClosed | GitHubError>;
    // Any other call, for what the service does not cover.
    request(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body: Option.Option<Json>,
    ): Effect.Effect<Json, GitHubError>;
  }
>()("@chernabog/sdk/GitHub") {}

export class Git extends Context.Service<
  Git,
  {
    run(args: ReadonlyArray<string>, cwd: string): Effect.Effect<string, GitError>;
    headSha(cwd: string): Effect.Effect<string, GitError>;
    // Commits on HEAD that origin/<base> does not have.
    commitsAhead(cwd: string, base: string): Effect.Effect<number, GitError>;
    changedFiles(cwd: string, base: string): Effect.Effect<ReadonlyArray<string>, GitError>;
    push(cwd: string, branch: string): Effect.Effect<void, PushRejected | GitError>;
    // Brings the checked-out branch up to its remote, fast-forward only.
    pull(cwd: string, branch: string): Effect.Effect<void, GitError>;
  }
>()("@chernabog/sdk/Git") {}

export class Worktree extends Context.Service<
  Worktree,
  {
    // The worktree for a branch, created from origin/<branch> (or origin/<base>) the first time
    // and reused after. With `runId`, one another run left is first reset to origin/<branch>;
    // the run's own is reused as is, uncommitted work and all.
    ensure(branch: string, runId?: string): Effect.Effect<string, GitError>;
    pathFor(branch: string): string;
    remove(branch: string): Effect.Effect<void, GitError>;
    // A detached worktree named `name`, reset to `ref` (fetched first) every call: for reading, such as a review.
    checkout(name: string, ref: string): Effect.Effect<string, GitError>;
  }
>()("@chernabog/sdk/Worktree") {}

export type LaunchDecision = { readonly launch: boolean; readonly reason: string };

export class Usage extends Context.Service<
  Usage,
  {
    // Whether the repo's account has room for one more task.
    readonly gate: Effect.Effect<LaunchDecision, UsageError>;
    // The account's logged-in identity; fails when it is not the expected one.
    readonly checkAccount: Effect.Effect<string, UsageError>;
  }
>()("@chernabog/sdk/Usage") {}

export type AgentResult = {
  readonly sessionId: string;
  readonly output: Json;
  readonly costUsd: Option.Option<number>;
};

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
  // A person works in the session with the agent, on the hybrid path: it
  // opens in front of them under the launcher, the agent is never sent back
  // to answer, and it is done once its answer is written. Only Claude under
  // a launcher can.
  readonly withPerson?: boolean;
  // The step that asks, such as `implement` or `fix-ci-2`. The Agent service
  // fills it in from the activity it runs in, when the caller leaves it out.
  readonly step?: string;
};

export class Agent extends Context.Service<
  Agent,
  {
    run(request: AgentRequest): Effect.Effect<AgentResult, AgentError>;
    readonly adapters: ReadonlyArray<string>;
  }
>()("@chernabog/sdk/Agent") {}

// The persona's seat in the team's reviewer pool: a login under github:, not
// the implicit account, that the repo's reviewers list. Every block that
// reviews requires it, so a flow that reviews does too. Chernabog checks it
// when it builds the persona's services; a flow that asks for a seat the
// persona doesn't hold stops there, before its work, and the engine reports
// why (NotInReviewerPool, PersonaUnavailable). No flow handles that.
export class ReviewerSeat extends Context.Service<
  ReviewerSeat,
  {
    // The reviewer's login.
    readonly login: Effect.Effect<string>;
  }
>()("@chernabog/sdk/ReviewerSeat") {}

// What this machine knows of a run, by id: whether it is still going, or none
// for a run it never had, such as one on another machine. Provided by Chernabog
// to triggers; a trigger reads it with Effect.serviceOption.
export class Runs extends Context.Service<
  Runs,
  {
    isActive(runId: string): Effect.Effect<Option.Option<boolean>>;
  }
>()("@chernabog/sdk/Runs") {}

// Writes to the run's log file, which `chernabog logs <run>` prints.
export class RunLog extends Context.Service<
  RunLog,
  {
    log(line: string): Effect.Effect<void>;
    step(name: string): Effect.Effect<void>;
    stepDone(name: string): Effect.Effect<void>;
  }
>()("@chernabog/sdk/RunLog") {}
