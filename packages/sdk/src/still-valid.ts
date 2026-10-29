// What the SDK's blocks count as a run's work item still being there, for a
// flow's stillValid: the issue or pull request is open, no other run holds
// its claim, and each pull request the run named as a subject is open. Each reads GitHub as
// the run's persona; a read that fails fails the check, which is not Gone.

import {
  Claims,
  GitHub,
  type GitHubError,
  gone,
  reportAs,
  Run,
  type RunInfo,
  valid,
  type Validity,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Gone when another run holds the claim on `item`; this run holding it, or
// nobody, is fine: a run may not have claimed it yet, or has let it go. A
// claim whose lease expired is nobody's: the run may be taking it over.
const claimValidity = (item: string, what: string) =>
  Effect.gen(function* () {
    const run = yield* Run;

    const other = Option.filter(
      yield* Claims.liveHolder(item),
      (found) => found.runId !== run.runId,
    );

    return Option.match(other, {
      onNone: (): Validity => valid,
      onSome: (found) => gone(`run ${found.runId} of ${found.flow} holds the claim on ${what}`),
    });
  });

// Gone when the pull request is closed, merged or no longer there.
const pullRequestOpen = (number: number) =>
  GitHub.use((github) => github.pullRequest(number)).pipe(
    Effect.map((pull): Validity => {
      if (pull.state === "open") {
        return valid;
      }

      return gone(`#${number} was ${pull.state}`);
    }),
    Effect.catchTag("NotFound", () => Effect.succeed(gone(`#${number} no longer exists`))),
  );

// Gone when the issue is closed or no longer there.
const issueOpen = (number: number) =>
  GitHub.use((github) => github.issue(number)).pipe(
    Effect.map((issue): Validity => {
      if (issue.state === "closed") {
        return gone(`#${number} was closed`);
      }

      return valid;
    }),
    Effect.catchTag("NotFound", () => Effect.succeed(gone(`#${number} no longer exists`))),
  );

export type IssueChecks = {
  // Whether each pull request the run named as a subject must still be open.
  readonly pullRequest: boolean;
};

const PULL_REQUEST_SUBJECT = /^pr-(\d+)$/;

// The pull requests the run named as subjects, or, from a binary from before
// subjects, the one it linked.
const pullRequestsOf = (run: RunInfo) =>
  Option.match(Option.fromUndefinedOr(run.subjects), {
    onNone: () => Option.toArray(Option.fromUndefinedOr(run.pullRequest)),
    onSome: (subjects) =>
      subjects.flatMap((subject) =>
        Option.toArray(
          Option.map(Option.fromNullOr(PULL_REQUEST_SUBJECT.exec(subject)), (match) =>
            Number(match[1]),
          ),
        ),
      ),
  });

// The first of `checks` that says gone, or valid.
const allValid = <R>(checks: ReadonlyArray<Effect.Effect<Validity, GitHubError, R>>) =>
  Effect.gen(function* () {
    for (const check of checks) {
      const validity = yield* check;

      if (!validity.valid) {
        return validity;
      }
    }

    return valid;
  });

// An issue's run: the issue is open, its claim is this run's or nobody's,
// and, when asked, each pull request it named as a subject is open.
export const issueValidity = (number: number, checks: IssueChecks) =>
  Effect.gen(function* () {
    const run = yield* Run;
    const open = yield* issueOpen(number);

    if (!open.valid) {
      return open;
    }

    const claim = yield* claimValidity(Claims.issue(number), `#${number}`);

    if (!claim.valid || !checks.pullRequest) {
      return claim;
    }

    return yield* allValid(pullRequestsOf(run).map(pullRequestOpen));
  }).pipe(reportAs("still-valid"));

// A pull request's run: the pull request is open, and its claim is this run's or nobody's.
export const pullRequestValidity = (number: number) =>
  Effect.gen(function* () {
    const open = yield* pullRequestOpen(number);

    if (!open.valid) {
      return open;
    }

    return yield* claimValidity(Claims.pullRequest(number), `#${number}`);
  }).pipe(reportAs("still-valid"));

// An epic's run: the epic is open, and its claim is this run's or nobody's.
export const epicValidity = (number: number) =>
  Effect.gen(function* () {
    const open = yield* issueOpen(number);

    if (!open.valid) {
      return open;
    }

    return yield* claimValidity(Claims.epic(number), `#${number}`);
  }).pipe(reportAs("still-valid"));
