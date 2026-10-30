import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";

import { howToStart, startFlowOf } from "./manual-flow.value-object.ts";

describe("chernabog start's entry point", () => {
  test("is the one flow that declares itself start's, whatever its name", () => {
    expect(
      startFlowOf("demo", [
        { name: "pair", start: true },
        { name: "pair", start: true },
        { name: "nightly", start: false },
      ]),
    ).toEqual(Result.succeed("pair"));
  });

  test("is refused when no flow declares it, or several do, naming them", () => {
    const none = startFlowOf("demo", [{ name: "nightly", start: false }]);

    const several = startFlowOf("demo", [
      { name: "pair", start: true },
      { name: "solo", start: true },
    ]);

    expect(Result.isFailure(none) && none.failure).toBe(
      "demo has no flow that chernabog start runs: none of its flows declares defineFlow({ start: true }). Add a recipe that does, or declare it on one of your own",
    );
    expect(Result.isFailure(several) && several.failure).toContain("(pair, solo)");
  });

  test("a manual flow says how to start it: start for the entry point, run for any other", () => {
    expect(howToStart("pair", true)).toBe("chernabog start <issue>");
    expect(howToStart("deploy", false)).toBe("chernabog run deploy --item <key>");
  });
});
