import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { SkipRoot } from "./skip.root.ts";
import { SkipSpecifications } from "./skip.specification.ts";

const skip = (repo: string, flow: string) =>
  SkipRoot.make({
    repo,
    persona: Option.none(),
    flow,
    itemKey: Option.none(),
    reason: "nothing to do",
    at: "2026-10-20T00:00:00Z",
  });

describe("SkipSpecifications", () => {
  test("all holds of every skip, and forFlow of one repo's flow", () => {
    const skips = [skip("demo", "review"), skip("demo", "merge"), skip("other", "review")];
    expect(skips.filter(SkipSpecifications.all)).toEqual(skips);
    expect(skips.filter(SkipSpecifications.forFlow("demo", "review"))).toEqual([skips[0]]);
  });
});
