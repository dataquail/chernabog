import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { claimOf, itemTarget } from "./work-item.value-object.ts";

describe("itemTarget", () => {
  test("reads an issue or a pull request from the SDK's item keys", () => {
    expect(itemTarget("issue-114")).toEqual(Option.some({ kind: "issue", number: 114 }));
    expect(itemTarget("pr-116")).toEqual(Option.some({ kind: "pull-request", number: 116 }));
    expect(itemTarget("pr-116-changes-2")).toEqual(
      Option.some({ kind: "pull-request", number: 116 }),
    );
  });

  test("a key of a flow's own names neither", () => {
    for (const key of ["nightly", "issue-", "issue-12-x", "pr-x", "prs-1"]) {
      expect(itemTarget(key)).toEqual(Option.none());
    }
  });
});

describe("claimOf", () => {
  test("names the claim a run on an issue or a pull request holds", () => {
    expect(claimOf({ kind: "issue", number: 7 })).toBe("issue-7");
    expect(claimOf({ kind: "pull-request", number: 116 })).toBe("pr-116");
  });
});
