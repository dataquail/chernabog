import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { type EnrolledRepoRoot } from "./enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "./enrolled-repo.root-ops.ts";

// What happens to an enrolled repo, as enrollment's commands tell whoever
// listens: the dashboard's /events stream, the notifier. A command dispatches
// one only after the write that makes it true, and only when the write changed
// what it says. A person's command runs once, so each carries an id from its
// repo, what happened and when: a repeat has the same id, for a consumer to
// drop.
//
// A change to a persona's flows, accounts or schedule, or to where a checkout
// is, says nothing: the daemon reads the entry again on its next tick.

// The id of an event about `repo`, such as "paused", at `at`.
export const enrollmentEventId = (repo: RepoSlug, what: string, at: string) =>
  `${repo}:${what}:${at}`;

// A checkout enrolled, as a new entry or over the one it had.
export const RepoEnrolled = Schema.TaggedStruct("RepoEnrolled", {
  eventId: Schema.String,
  repo: RepoSlug,
  name: Schema.String,
  path: Schema.String,
  added: Schema.Boolean,
  enrolledAt: Schema.String,
});

export type RepoEnrolled = typeof RepoEnrolled.Type;

// A repo paused: it starts no new runs, and the runs in flight continue.
export const RepoPaused = Schema.TaggedStruct("RepoPaused", {
  eventId: Schema.String,
  repo: RepoSlug,
  name: Schema.String,
  pausedAt: Schema.String,
});

export type RepoPaused = typeof RepoPaused.Type;

// A paused repo resumed: it starts runs again.
export const RepoResumed = Schema.TaggedStruct("RepoResumed", {
  eventId: Schema.String,
  repo: RepoSlug,
  name: Schema.String,
  resumedAt: Schema.String,
});

export type RepoResumed = typeof RepoResumed.Type;

// A repo's entry removed: the daemon runs nothing in that checkout again.
export const RepoUnenrolled = Schema.TaggedStruct("RepoUnenrolled", {
  eventId: Schema.String,
  repo: RepoSlug,
  name: Schema.String,
  path: Schema.String,
  unenrolledAt: Schema.String,
});

export type RepoUnenrolled = typeof RepoUnenrolled.Type;

const enrolled = (repo: EnrolledRepoRoot, added: boolean, at: string) =>
  RepoEnrolled.make({
    eventId: enrollmentEventId(repo.repo, "enrolled", at),
    repo: repo.repo,
    name: EnrolledRepoRootOps.nameOf(repo),
    path: repo.path,
    added,
    enrolledAt: at,
  });

// The pause or resume that took `before` to `after`; none when it was already so.
const pausedOrResumed = (
  before: EnrolledRepoRoot,
  after: EnrolledRepoRoot,
  at: string,
): ReadonlyArray<RepoPaused | RepoResumed> => {
  if (before.paused === after.paused) {
    return [];
  }

  const name = EnrolledRepoRootOps.nameOf(after);

  if (after.paused) {
    return [
      RepoPaused.make({
        eventId: enrollmentEventId(after.repo, "paused", at),
        repo: after.repo,
        name,
        pausedAt: at,
      }),
    ];
  }

  return [
    RepoResumed.make({
      eventId: enrollmentEventId(after.repo, "resumed", at),
      repo: after.repo,
      name,
      resumedAt: at,
    }),
  ];
};

const unenrolled = (repo: EnrolledRepoRoot, at: string) =>
  RepoUnenrolled.make({
    eventId: enrollmentEventId(repo.repo, "unenrolled", at),
    repo: repo.repo,
    name: EnrolledRepoRootOps.nameOf(repo),
    path: repo.path,
    unenrolledAt: at,
  });

export const EnrollmentEvents = {
  enrolled,
  pausedOrResumed,
  unenrolled,
} as const;
