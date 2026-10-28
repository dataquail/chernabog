// What the SDK's blocks count as a run's work item still being there, for a
// flow's stillValid: the issue or pull request is open, no other run holds
// its claim, and a pull request the run opened is open. Each reads GitHub as
// the run's persona; a read that fails fails the check, which is not Gone.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Claims from "./claims.ts";
import { gone, reportAs, valid, type Validity } from "./flow.ts";
import { GitHub, Run } from "./services.ts";

// Gone when another run holds the claim on `item`; this run holding it, or
// nobody, is fine: a run may not have claimed it yet, or has let it go.
const claimValidity = (item: string, what: string) =>
  Effect.gen(function* () {
    const run = yield* Run;

    const other = Option.filter(
      yield* Claims.holder(item),
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
  // Whether a pull request the run opened must still be open.
  readonly pullRequest: boolean;
};

// An issue's run: the issue is open, its claim is this run's or nobody's,
// and, when asked, the pull request the run opened is open.
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

    return yield* Option.match(Option.fromUndefinedOr(run.pullRequest), {
      onNone: () => Effect.succeed<Validity>(valid),
      onSome: pullRequestOpen,
    });
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
