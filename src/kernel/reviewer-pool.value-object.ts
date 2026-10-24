// The team's reviewer pool (reviewers: in its config), as the machine serves
// it (#76). A pull request asks one login from the pool, never its author;
// when that login isn't a persona on this machine, every call succeeds and the
// review flow simply finds nothing, so doctor, enroll and status say who the
// request waits on. Another person's machine may serve that login, so it's a
// note, never a failure.

import * as Option from "effect/Option";

// The recipes that open pull requests and ask the pool to review them.
const AUTHORING_RECIPES = ["implement", "human-initiated"];

// A flow's code that asks for a review: PullRequest.requestReview, or a hand-off that calls it.
const ASKS_FOR_REVIEW = /\b(requestReview|handOff)\b/;

// The recipe that reviews a pull request when its review is requested.
const REVIEWING_RECIPES = ["review"];

// A flow's code that reviews: a round of review, or the requests it answers.
const REVIEWS = /\bReview\.(round|reviewRequests)\b/;

// Logins compare as GitHub compares them, ignoring case.
export const sameLogin = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

export const actsAs = (here: ReadonlyArray<string>) => (login: string) =>
  here.some((own) => sameLogin(own, login));

// Whether a flow opens pull requests that ask the pool for a review, by its
// name or its code.
export const authorsPullRequests = (name: string, source: string) =>
  AUTHORING_RECIPES.includes(name) || ASKS_FOR_REVIEW.test(source);

// Whether a flow reviews the pull requests asked of its persona, by its name or its code.
export const reviewsPullRequests = (name: string, source: string) =>
  REVIEWING_RECIPES.includes(name) || REVIEWS.test(source);

// The logins a pull request authored as `author` may ask, when none of them is
// a persona here (`here`). None when one is, or when the pool is empty, which
// labels the pull request for a person instead.
export const unservedReviewers = (
  reviewers: ReadonlyArray<string>,
  author: Option.Option<string>,
  here: ReadonlyArray<string>,
) =>
  Option.liftPredicate(
    reviewers.filter((login) => !Option.exists(author, (own) => sameLogin(own, login))),
    (pool) => pool.length > 0 && !pool.some(actsAs(here)),
  );
