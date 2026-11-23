// The domain layer the step definitions are written against (ADR 22,
// decision 5): what a scenario can arrange, do and see, in the spec's own
// terms. Each driver implements it its own way (in-process over the SDK
// fakes, sandbox over the real CLI and fake GitHub), and a step names only
// this, so one scenario runs the same on each. It holds no driver's types.
//
// It is as small as the review loop needs (test/features/review-loop.feature)
// and grows with the features.

import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A GitHub login: a persona on this machine, or a person.
export type Login = string;

// How a review came out.
export type Verdict = "approved" | "changes-requested" | "commented";

// What the driver could not do or see, said in the spec's terms.
export class DomainFailed extends Schema.TaggedError<
  DomainFailed,
  { readonly brand: "DomainFailed" }
>()("DomainFailed", {
  message: Schema.String,
}) {}

export type IssueSeen = {
  readonly number: number;
  readonly labels: ReadonlyArray<string>;
};

export type PullRequestSeen = {
  readonly number: number;
  readonly author: Login;
  // The issue it was opened for, when it was opened for one.
  readonly issue: Option.Option<number>;
  // Its head commit now.
  readonly head: string;
  // Who is asked to review it now.
  readonly requested: ReadonlyArray<Login>;
  readonly mergedBy: Option.Option<Login>;
};

// Where an event is in the world's one order of events: one that happened
// before another has a smaller sequence, whatever kind each is, so a step can
// say "since" or "again" by comparing them. Events that overlapped may be in
// either order.
export type Sequenced = { readonly sequence: number };

export type ReviewSeen = Sequenced & {
  readonly pullRequest: number;
  readonly reviewer: Login;
  readonly verdict: Verdict;
  // The head commit the review is of.
  readonly head: string;
  // How many of its comments are on a line of the diff.
  readonly lineComments: number;
};

// A comment that answers a review, rather than reviewing.
export type ReplySeen = Sequenced & {
  readonly pullRequest: number;
  readonly author: Login;
  // The author's reasons for not making the changes the review asks for,
  // when it gives them rather than saying what it changed.
  readonly reasons: Option.Option<string>;
};

export type PushSeen = Sequenced & {
  readonly pullRequest: number;
  readonly by: Login;
  readonly head: string;
};

export type ReviewRequestSeen = Sequenced & {
  readonly pullRequest: number;
  readonly reviewer: Login;
  readonly by: Login;
};

export type HandOffSeen = Sequenced & {
  readonly pullRequest: number;
};

// One stretch of an agent's work on a pull request, in the agent session it
// ran in: two with the same session are the same conversation carried on.
export type SessionSeen = Sequenced & {
  readonly pullRequest: number;
  readonly persona: Login;
  readonly session: string;
  // Whether it carried on a session that already was, rather than starting one.
  readonly resumed: boolean;
};

export type MergeSeen = Sequenced & {
  readonly pullRequest: number;
  readonly by: Login;
};

// Everything a scenario can observe. The lists after pullRequests are
// histories, each in the world's one order of events (Sequenced), so a step
// can say "never" and "since" as well as "now".
export type World = {
  readonly issues: ReadonlyArray<IssueSeen>;
  readonly pullRequests: ReadonlyArray<PullRequestSeen>;
  readonly reviews: ReadonlyArray<ReviewSeen>;
  readonly replies: ReadonlyArray<ReplySeen>;
  readonly pushes: ReadonlyArray<PushSeen>;
  readonly reviewRequests: ReadonlyArray<ReviewRequestSeen>;
  readonly handOffs: ReadonlyArray<HandOffSeen>;
  readonly sessions: ReadonlyArray<SessionSeen>;
  readonly merges: ReadonlyArray<MergeSeen>;
};

export type Domain = {
  // These personas are set up on this machine, each a GitHub login chernabog
  // acts as.
  readonly personas: (logins: ReadonlyArray<Login>) => Effect.Effect<void, DomainFailed>;
  // These personas review for the team: the reviewer pool.
  readonly reviewForTheTeam: (logins: ReadonlyArray<Login>) => Effect.Effect<void, DomainFailed>;
  // This persona's agent, as an author, disagrees with the changes a review
  // asks for, rather than making them.
  readonly willDispute: (author: Login) => Effect.Effect<void, DomainFailed>;
  // Someone files an issue with these labels; its number.
  readonly fileIssue: (labels: ReadonlyArray<string>) => Effect.Effect<number, DomainFailed>;
  // A person, not a persona, opens a pull request; its number.
  readonly openPullRequest: (author: Login) => Effect.Effect<number, DomainFailed>;
  // A person asks these logins to review a pull request.
  readonly askToReview: (
    pullRequest: number,
    reviewers: ReadonlyArray<Login>,
  ) => Effect.Effect<void, DomainFailed>;
  // What can be seen now.
  readonly world: Effect.Effect<World, DomainFailed>;
  // Lets the machine work until what it sees answers `find`, and gives the
  // answer; fails, saying it waited for `description`, if it never does.
  readonly waitUntil: <A>(
    description: string,
    find: (world: World) => Option.Option<A>,
  ) => Effect.Effect<A, DomainFailed>;
  // Lets the machine work until it has nothing left to do, so a step can say
  // something never happened.
  readonly settle: Effect.Effect<void, DomainFailed>;
};
