import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { runLabel, shortRunId } from "./run-id.id.ts";

describe("run ids", () => {
  test("a random id shows as its first eight characters; an old readable one, whole", () => {
    expect(shortRunId("3f2a9c1e-7b4d-4e8a-9c2f-1d5e6a7b8c9d")).toBe("3f2a9c1e");
    expect(shortRunId("demo.implement.issue-7.20261021-120000")).toBe(
      "demo.implement.issue-7.20261021-120000",
    );
  });

  test("a label says what a run is, and as whom", () => {
    expect(
      runLabel({ repo: "demo", flow: "review", itemKey: "pr-12", persona: Option.some("bob") }),
    ).toBe("demo/review pr-12 as bob");
    expect(
      runLabel({ repo: "demo", flow: "review", itemKey: "pr-12", persona: Option.none() }),
    ).toBe("demo/review pr-12");
  });
});
