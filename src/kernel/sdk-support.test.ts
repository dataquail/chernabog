import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { pinnedVersion, sdkSupport } from "./sdk-support.value-object.ts";

describe("the SDK versions this binary runs", () => {
  test("say which side is behind for a version outside them", () => {
    expect(sdkSupport("0.5.9")).toBe("older");
    expect(sdkSupport("0.6.3")).toBe("supported");
    expect(sdkSupport("0.7.2")).toBe("supported");
    expect(sdkSupport("0.8.0")).toBe("newer");
    expect(sdkSupport("1.0.0")).toBe("newer");
  });

  test("a pin names a version, exact or with a prefix, and never a range", () => {
    expect(pinnedVersion("0.6.0")).toEqual(Option.some("0.6.0"));
    expect(pinnedVersion("^0.6.1")).toEqual(Option.some("0.6.1"));
    expect(pinnedVersion(">=0.6.0")).toEqual(Option.none());
    expect(pinnedVersion("latest")).toEqual(Option.none());
  });
});
