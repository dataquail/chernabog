import { describe, expect, test } from "bun:test";

import { waitingElsewhere } from "./review-requests.value-object.ts";

describe("review requests waiting elsewhere", () => {
  test("open pull requests waiting on a login this machine does not act as", () => {
    const pulls = [
      { number: 73, requestedReviewers: ["data-quail"] },
      { number: 74, requestedReviewers: ["Alice"] },
      { number: 75, requestedReviewers: [] },
    ];

    expect(waitingElsewhere(pulls, ["alice"])).toEqual([
      "#73 waits on data-quail (not on this machine)",
    ]);
  });
});
