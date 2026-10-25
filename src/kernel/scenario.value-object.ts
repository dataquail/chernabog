// A rehearsal's scenario (#115), as a person writes it in
// .chernabog/rehearsals/<name>.yaml: the repo to rehearse on, the GitHub state
// to seed there, the stand-ins that answer for the agent, and where the run
// should end. The rehearsals module reads it, and `chernabog init` writes its
// JSON Schema beside config.schema.json.

import * as Schema from "effect/Schema";

import { StandIns } from "./stand-in.value-object.ts";

const Strings = Schema.Array(Schema.String);

// An issue to open. `name` is what the rest of the scenario calls it.
export const IssueSeed = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Strings),
  assignees: Schema.optionalKey(Strings),
});

export type IssueSeed = typeof IssueSeed.Type;

// One commit on a seeded pull request's branch: each file's whole content, by path.
export const CommitSeed = Schema.Struct({
  message: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
});

export type CommitSeed = typeof CommitSeed.Type;

// A pull request to open from a new branch with these commits, on the base
// branch unless it names another, asking `reviewers` to review it.
export const PullRequestSeed = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Strings),
  commits: Schema.Array(CommitSeed),
  reviewers: Schema.optionalKey(Strings),
});

export type PullRequestSeed = typeof PullRequestSeed.Type;

// The GitHub state to seed, as the login `as` (a persona under github:), or
// as the persona the flow runs as. A pull request a review flow is to pick up
// should be seeded by another login than the reviewer's.
export const Given = Schema.Struct({
  as: Schema.optionalKey(Schema.String),
  issues: Schema.optionalKey(Schema.Array(IssueSeed)),
  pullRequests: Schema.optionalKey(Schema.Array(PullRequestSeed)),
});

export type Given = typeof Given.Type;

// `running`: still going when the rehearsal stopped following it (--timeout), such
// as a run waiting on a review no persona serves. `cancelled`: by `chernabog cancel`.
export const Ending = Schema.Literals([
  "done",
  "needs-human",
  "skipped",
  "failed",
  "cancelled",
  "running",
]);

export type Ending = typeof Ending.Type;

// Where the run should end: how, a phrase its summary carries (a NeedsHuman's
// reason, say), and every label the item it worked on should carry after.
export const Expectation = Schema.Struct({
  ends: Schema.optionalKey(Ending),
  summary: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Strings),
});

export type Expectation = typeof Expectation.Type;

export const ScenarioFile = Schema.Struct({
  // The owner/name to rehearse on. Never an enrolled repo, unless `enrolled` says so.
  repo: Schema.String,
  // The flow it rehearses; `chernabog rehearse <flow>` must name the same one.
  flow: Schema.optionalKey(Schema.String),
  // The persona the flow runs as, for a repo that runs as several.
  persona: Schema.optionalKey(Schema.String),
  // Rehearse on a repo this machine is enrolled in. Chernabog pauses it here
  // meanwhile; another machine's daemon may still pick up what is seeded.
  enrolled: Schema.optionalKey(Schema.Boolean),
  // The install step and local gate to run in place of the team's, for a
  // scratch repo that can't pass them: install: null runs none, and
  // localGate: ["true"] passes.
  install: Schema.optionalKey(Schema.OptionFromNullOr(Schema.String)),
  localGate: Schema.optionalKey(Strings),
  given: Schema.optionalKey(Given),
  // What answers for the agent at each step, by step name or a pattern such as fix-ci-*.
  agent: Schema.optionalKey(StandIns),
  expect: Schema.optionalKey(Expectation),
});

export type ScenarioFile = typeof ScenarioFile.Type;
