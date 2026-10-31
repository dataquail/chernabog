import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { HoldsRoot } from "./holds.root.ts";
import { HoldsSpecifications } from "./holds.specification.ts";

const holds = (repo: string, flow: string) =>
  HoldsRoot.make({
    repo,
    persona: Option.none(),
    flow,
    items: [{ itemKey: "issue-1", reason: "blocked" }],
    at: "2026-10-20T00:00:00Z",
  });

describe("HoldsSpecifications", () => {
  test("all holds of every flow's holds, and forRepo of one repo's", () => {
    const stored = [holds("demo", "implement"), holds("other", "implement")];
    expect(stored.filter(HoldsSpecifications.all)).toEqual(stored);
    expect(stored.filter(HoldsSpecifications.forRepo("other"))).toEqual([stored[1]]);
  });
});
