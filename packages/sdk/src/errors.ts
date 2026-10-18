import * as Schema from 'effect/Schema';

// Ends a run cleanly: nothing to do, or a gate said not now. Never a failure.
export class Skip extends Schema.TaggedError<Skip, { readonly brand: 'Skip' }>()('Skip', {
  reason: Schema.String,
}) {}

// Hands a work item to a person: the flow labels it and no flow picks it up again.
export class NeedsHuman extends Schema.TaggedError<NeedsHuman, { readonly brand: 'NeedsHuman' }>()('NeedsHuman', {
  reason: Schema.String,
}) {}

export class GitHubError extends Schema.TaggedError<GitHubError, { readonly brand: 'GitHubError' }>()('GitHubError', {
  message: Schema.String,
}) {}

export class GitError extends Schema.TaggedError<GitError, { readonly brand: 'GitError' }>()('GitError', {
  message: Schema.String,
}) {}

export class AgentError extends Schema.TaggedError<AgentError, { readonly brand: 'AgentError' }>()('AgentError', {
  message: Schema.String,
}) {}

export class UsageError extends Schema.TaggedError<UsageError, { readonly brand: 'UsageError' }>()('UsageError', {
  message: Schema.String,
}) {}

// A step or activity that failed for any other reason, named so the run log says which.
export class StepFailed extends Schema.TaggedError<StepFailed, { readonly brand: 'StepFailed' }>()('StepFailed', {
  step: Schema.String,
  message: Schema.String,
}) {}
