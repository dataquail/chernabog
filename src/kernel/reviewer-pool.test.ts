import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import {
  authorsPullRequests,
  reviewsPullRequests,
  unservedReviewers,
} from "./reviewer-pool.value-object.ts";

describe("review requests no persona here serves", () => {
  test("a flow authors pull requests by its recipe name, or code that asks for a review", () => {
    expect(authorsPullRequests("implement", "")).toBe(true);
    expect(authorsPullRequests("human-initiated", "")).toBe(true);
    expect(authorsPullRequests("ship-docs", "yield* PullRequest.requestReview(pull.number)")).toBe(
      true,
    );
    expect(
      authorsPullRequests("ship-docs", "yield* Implement.handOff(issue, opened, outcome)"),
    ).toBe(true);
    expect(authorsPullRequests("review", "yield* Review.round(pullRequest, 1)")).toBe(false);
  });

  test("a flow reviews by its recipe name, or code that reviews", () => {
    expect(reviewsPullRequests("review", "")).toBe(true);
    expect(reviewsPullRequests("triage", "yield* Review.round(pullRequest, 1)")).toBe(true);
    expect(
      reviewsPullRequests("implement", "yield* Implement.handOff(issue, opened, outcome)"),
    ).toBe(false);
  });

  test("the pool, less the author, when none of it is a persona here", () => {
    expect(unservedReviewers(["alice", "bob"], Option.some("alice"), ["alice"])).toEqual(
      Option.some(["bob"]),
    );
    expect(unservedReviewers(["alice", "Bob"], Option.some("ALICE"), ["alice", "bob"])).toEqual(
      Option.none(),
    );
    // Only the author in the pool, or no pool: a person is asked instead.
    expect(unservedReviewers(["alice"], Option.some("alice"), [])).toEqual(Option.none());
    expect(unservedReviewers([], Option.some("alice"), [])).toEqual(Option.none());
    // An author gh can't name leaves the whole pool.
    expect(unservedReviewers(["alice", "bob"], Option.none(), [])).toEqual(
      Option.some(["alice", "bob"]),
    );
  });
});
