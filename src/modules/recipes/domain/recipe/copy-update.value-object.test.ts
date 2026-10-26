import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { planCopyUpdate } from "./copy-update.value-object.ts";

const target = { from: "@chernabog/recipes/review", version: "0.2.0" };
const old = Option.some({ ...target, version: "0.1.0" });

const plan = (ours: Option.Option<string>, record: typeof old, unrecorded = "adopt" as const) =>
  planCopyUpdate({ ours, theirs: "new", record, target, unrecorded });

describe("planCopyUpdate", () => {
  test("writes a file the repo lacks, and only moves the record of one that's the recipe's", () => {
    expect(plan(Option.none(), old)).toBe("written");
    expect(plan(Option.some("new"), old)).toBe("record");
    expect(plan(Option.some("new"), Option.none())).toBe("record");
  });

  test("leaves a file recorded at the version it moves to, edits and all", () => {
    expect(plan(Option.some("edited"), Option.some(target))).toBe("unchanged");
  });

  test("merges a recorded file from its version, and adopts or replaces an unrecorded one", () => {
    expect(plan(Option.some("edited"), old)).toBe("merge");
    expect(plan(Option.some("edited"), Option.none())).toBe("adopted");
    expect(
      planCopyUpdate({
        ours: Option.some("edited"),
        theirs: "new",
        record: Option.none(),
        target,
        unrecorded: "replace",
      }),
    ).toBe("replaced");
  });
});
