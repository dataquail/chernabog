// What can go wrong, split by who acts on it. A flow ends in one of its own
// outcomes (Skip, NeedsHuman, StepFailed). The work's errors are typed at the
// call that raises them, and a flow must handle each one before it compiles.
// The errors a flow can only report (GitHubError and the like) become
// StepFailed. Setup errors are raised while a persona's services are built,
// before any flow runs, and the engine reports them; no flow sees one.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Ends a run cleanly: nothing to do, or a gate said not now. Never a failure.
export class Skip extends Schema.TaggedError<Skip, { readonly brand: "Skip" }>()("Skip", {
  reason: Schema.String,
}) {}

// Hands a work item to a person: the flow labels it and no flow picks it up again.
export class NeedsHuman extends Schema.TaggedError<NeedsHuman, { readonly brand: "NeedsHuman" }>()(
  "NeedsHuman",
  {
    reason: Schema.String,
  },
) {}

// A step or activity that failed for any other reason, named so the run log says which.
export class StepFailed extends Schema.TaggedError<StepFailed, { readonly brand: "StepFailed" }>()(
  "StepFailed",
  {
    step: Schema.String,
    message: Schema.String,
  },
) {}

// The errors a flow can only report, each with a message that says what failed.
// An activity turns them into StepFailed.

export class GitHubError extends Schema.TaggedError<
  GitHubError,
  { readonly brand: "GitHubError" }
>()("GitHubError", {
  message: Schema.String,
}) {}

export class GitError extends Schema.TaggedError<GitError, { readonly brand: "GitError" }>()(
  "GitError",
  {
    message: Schema.String,
  },
) {}

export class AgentError extends Schema.TaggedError<AgentError, { readonly brand: "AgentError" }>()(
  "AgentError",
  {
    message: Schema.String,
  },
) {}

export class UsageError extends Schema.TaggedError<UsageError, { readonly brand: "UsageError" }>()(
  "UsageError",
  {
    message: Schema.String,
  },
) {}

export type ReportedError = GitHubError | GitError | AgentError | UsageError;

// The work's errors: each one a flow can decide on.

// An issue or pull request GitHub doesn't have, such as one deleted or transferred.
export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: "NotFound" }>()(
  "NotFound",
  {
    what: Schema.String,
  },
) {
  override get message() {
    return `${this.what} not found`;
  }
}

// A pull request closed or merged before the call that needed it open.
export class PullRequestClosed extends Schema.TaggedError<
  PullRequestClosed,
  { readonly brand: "PullRequestClosed" }
>()("PullRequestClosed", {
  pullRequest: Schema.Finite,
  state: Schema.Literals(["closed", "merged"]),
}) {
  override get message() {
    return `#${this.pullRequest} is ${this.state}`;
  }
}

// A merge that isn't safe, or that GitHub refused, with why.
export class MergeRefused extends Schema.TaggedError<
  MergeRefused,
  { readonly brand: "MergeRefused" }
>()("MergeRefused", {
  pullRequest: Schema.Finite,
  reason: Schema.String,
}) {
  override get message() {
    return `#${this.pullRequest} not merged: ${this.reason}`;
  }
}

// A push the remote refused: a branch that moved since, or a token without a
// scope the change needs, such as `workflow` for a change to .github/workflows/.
export class PushRejected extends Schema.TaggedError<
  PushRejected,
  { readonly brand: "PushRejected" }
>()("PushRejected", {
  branch: Schema.String,
  reason: Schema.String,
  missingScope: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    const rejected = `pushing ${this.branch} was rejected: ${this.reason}`;

    return Option.match(Option.fromUndefinedOr(this.missingScope), {
      onNone: () => rejected,
      onSome: (scope) =>
        `${rejected}. Fix: give the token it pushes with the \`${scope}\` scope (\`gh auth refresh --hostname github.com --scopes ${scope}\`, logged in as that account), then push ${this.branch} again`,
    });
  }
}

// The branch has nothing to push: the agent finished without committing.
export class NothingCommitted extends Schema.TaggedError<
  NothingCommitted,
  { readonly brand: "NothingCommitted" }
>()("NothingCommitted", {
  branch: Schema.String,
}) {
  override get message() {
    return `nothing was committed on ${this.branch}`;
  }
}

// CI stayed pending for longer than limits.ciTimeout.
export class CiTimedOut extends Schema.TaggedError<CiTimedOut, { readonly brand: "CiTimedOut" }>()(
  "CiTimedOut",
  {
    pullRequest: Schema.Finite,
    after: Schema.String,
  },
) {
  override get message() {
    return `CI on #${this.pullRequest} is still pending after ${this.after}`;
  }
}

export const WorkError = Schema.Union([
  NotFound,
  PullRequestClosed,
  MergeRefused,
  PushRejected,
  NothingCommitted,
  CiTimedOut,
]);

export type WorkError = typeof WorkError.Type;

// Setup errors: what a person fixes in their configuration or logins. Each
// names its fix.

// A persona under github: whose token gh can't give: not logged in, or logged out since.
export class PersonaUnavailable extends Schema.TaggedError<
  PersonaUnavailable,
  { readonly brand: "PersonaUnavailable" }
>()("PersonaUnavailable", {
  login: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.login} is unavailable: ${this.reason}. Fix: run \`gh auth login --hostname github.com\` as ${this.login}, or take it out of github: in machine config`;
  }
}

// No token for the implicit account: no GH_TOKEN or GITHUB_TOKEN, and gh has no login.
export class NotAuthenticated extends Schema.TaggedError<
  NotAuthenticated,
  { readonly brand: "NotAuthenticated" }
>()("NotAuthenticated", {
  reason: Schema.String,
}) {
  override get message() {
    return `not authenticated to GitHub: ${this.reason}. Fix: set GH_TOKEN, run \`gh auth login\`, or name a persona under github: in machine config`;
  }
}

// A flow that reviews runs as a persona that has no seat in the reviewer
// pool: the implicit account, or a login the repo's reviewers leave out.
export class NotInReviewerPool extends Schema.TaggedError<
  NotInReviewerPool,
  { readonly brand: "NotInReviewerPool" }
>()("NotInReviewerPool", {
  login: Schema.optionalKey(Schema.String),
  reviewers: Schema.Array(Schema.String),
}) {
  override get message() {
    const pool = Option.match(
      Option.liftPredicate(this.reviewers, (logins) => logins.length > 0),
      {
        onNone: () => "the repo names no reviewers",
        onSome: (logins) => `reviewers: ${logins.join(", ")}`,
      },
    );

    return Option.match(Option.fromUndefinedOr(this.login), {
      onNone: () =>
        `a flow that reviews runs as the implicit account, which has no seat in the reviewer pool (${pool}). Fix: run it as a persona under github: that the repo's reviewers list`,
      onSome: (login) =>
        `${login} has no seat in the reviewer pool (${pool}). Fix: add ${login} to reviewers in .chernabog/config.yaml, or turn the flow off for ${login}`,
    });
  }
}

export const SetupError = Schema.Union([PersonaUnavailable, NotAuthenticated, NotInReviewerPool]);

export type SetupError = typeof SetupError.Type;

export const isSetupError = Schema.is(SetupError);
