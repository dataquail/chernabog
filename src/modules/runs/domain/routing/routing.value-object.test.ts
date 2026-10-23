import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import {
  describeElsewhere,
  namesMe,
  routeItems,
  waitingElsewhere,
} from "./routing.value-object.ts";

describe("routing by assignee and requested reviewer", () => {
  const issue = (key: string, assignees: ReadonlyArray<string>) => ({ key, data: {}, assignees });

  // issue-3 comes from a trigger that says nothing about assignees.
  const issues = [
    issue("issue-1", ["alice"]),
    issue("issue-2", []),
    { key: "issue-3", data: {} },
    issue("issue-4", ["Bob", "Alice"]),
  ];

  const pulls = [
    { key: "pr-5", data: {}, assignees: ["carol"], reviewers: ["alice"] },
    { key: "pr-6", data: {}, assignees: [], reviewers: [] },
  ];

  const keys = (routed: ReturnType<typeof routeItems>) => ({
    mine: routed.mine.map((found) => found.key),
    elsewhere: routed.elsewhere.map((found) => found.key),
  });

  const routing = (
    assignee: Option.Option<ReadonlyArray<string>>,
    reviewRequested: Option.Option<ReadonlyArray<string>> = Option.none(),
  ) => ({ assignee, reviewRequested });

  test("without a filter, anything starts", () => {
    expect(keys(routeItems(issues, routing(Option.none()), Option.some("carol")))).toEqual({
      mine: ["issue-1", "issue-2", "issue-3", "issue-4"],
      elsewhere: [],
    });
  });

  test("@me is this machine, none is nobody, and a login is that person", () => {
    expect(
      keys(routeItems(issues, routing(Option.some(["@me", "none"])), Option.some("bob"))),
    ).toEqual({ mine: ["issue-2", "issue-3", "issue-4"], elsewhere: ["issue-1"] });
    expect(keys(routeItems(issues, routing(Option.some(["@me"])), Option.some("ALICE")))).toEqual({
      mine: ["issue-1", "issue-4"],
      elsewhere: ["issue-2", "issue-3"],
    });
    expect(keys(routeItems(issues, routing(Option.some(["Alice"])), Option.some("carol")))).toEqual(
      { mine: ["issue-1", "issue-4"], elsewhere: ["issue-2", "issue-3"] },
    );
  });

  test("with no known login, @me matches no one", () => {
    expect(keys(routeItems(issues, routing(Option.some(["@me", "none"])), Option.none()))).toEqual({
      mine: ["issue-2", "issue-3"],
      elsewhere: ["issue-1", "issue-4"],
    });
  });

  test("requested reviewers route pull requests, and every filter set must pass", () => {
    expect(
      keys(routeItems(pulls, routing(Option.none(), Option.some(["@me"])), Option.some("alice"))),
    ).toEqual({ mine: ["pr-5"], elsewhere: ["pr-6"] });
    expect(
      keys(
        routeItems(
          pulls,
          routing(Option.some(["@me"]), Option.some(["@me"])),
          Option.some("alice"),
        ),
      ),
    ).toEqual({ mine: [], elsewhere: ["pr-5", "pr-6"] });
    expect(describeElsewhere(routing(Option.some(["@me"]), Option.some(["@me"])))(pulls[1])).toBe(
      "pr-6 (assignee: none; review requested: none)",
    );
    expect(describeElsewhere(routing(Option.none(), Option.some(["@me"])))(pulls[0])).toBe(
      "pr-5 (review requested: alice)",
    );
  });

  test("a filter names this machine when it lists @me", () => {
    expect(namesMe(Option.some(["alice", "@ME"]))).toBe(true);
    expect(namesMe(Option.some(["alice"]))).toBe(false);
    expect(namesMe(Option.none())).toBe(false);
  });
});

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
