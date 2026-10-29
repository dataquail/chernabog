// The review requests no persona on this machine serves, which status lists
// for the review flow, whose trigger never finds them.

import * as Option from "effect/Option";

import { actsAs } from "../../../../kernel/reviewer-pool.value-object.ts";

// The flow whose status lists the review requests no persona here serves.
export const REVIEW_FLOW = "review";

// An open pull request, as far as its review requests go.
export type ReviewRequest = {
  readonly number: number;
  readonly requestedReviewers: ReadonlyArray<string>;
};

// Open pull requests waiting on a review from a login this machine doesn't
// act as, as status lists them: "#73 waits on data-quail (not on this machine)".
export const waitingElsewhere = (
  pulls: ReadonlyArray<ReviewRequest>,
  here: ReadonlyArray<string>,
) =>
  pulls.flatMap((pull) => {
    const others = pull.requestedReviewers.filter((login) => !actsAs(here)(login));

    return Option.toArray(
      Option.liftPredicate(
        `#${pull.number} waits on ${others.join(", ")} (not on this machine)`,
        () => others.length > 0,
      ),
    );
  });
