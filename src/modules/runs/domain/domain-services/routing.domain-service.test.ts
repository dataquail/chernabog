import { describe, expect, test } from "bun:test";

import { Routing } from "./routing.domain-service.ts";

describe("routing, as the flow decides it", () => {
  // The flow's trigger leaves issue-1 to alice, and pr-5 to its team, by a
  // label: the engine reads only the reason.
  const items = [
    { key: "issue-1", data: {}, elsewhere: "assignee: alice" },
    { key: "issue-2", data: {} },
    { key: "pr-5", data: {}, elsewhere: "label: team-b" },
  ];

  test("an item the flow leaves for others doesn't start here; any other does", () => {
    const routed = Routing.split(items);

    expect(routed.mine.map((found) => found.key)).toEqual(["issue-2"]);
    expect(routed.elsewhere.map((found) => found.key)).toEqual(["issue-1", "pr-5"]);
  });

  test("a flow that routes nothing starts every item its trigger reports", () => {
    const routed = Routing.split([{ key: "issue-2", data: {} }]);

    expect(routed.mine.map((found) => found.key)).toEqual(["issue-2"]);
    expect(routed.elsewhere).toEqual([]);
  });

  test("an item left for others reads with the flow's reason", () => {
    expect(Routing.split(items).elsewhere.map(Routing.describeElsewhere)).toEqual([
      "issue-1 (assignee: alice)",
      "pr-5 (label: team-b)",
    ]);
  });
});
