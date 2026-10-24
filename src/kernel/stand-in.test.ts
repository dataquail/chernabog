import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { standInFor, unmatchedKeys } from "./stand-in.value-object.ts";

describe("stand-ins", () => {
  test("a step's stand-in is the one named for it, else the first pattern that matches", () => {
    const standIns = {
      implement: { fixture: { status: "done" } },
      "fix-ci-*": { fixture: { status: "fixed" } },
    };

    expect(standInFor(standIns, "implement")).toEqual(Option.some(standIns.implement));
    expect(standInFor(standIns, "fix-ci-2")).toEqual(Option.some(standIns["fix-ci-*"]));
    expect(standInFor(standIns, "fix-local-gate-1")).toEqual(Option.none());
    expect(unmatchedKeys(standIns, ["implement", "review-1"])).toEqual(["fix-ci-*"]);
  });
});
