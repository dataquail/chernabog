import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { pinnedVersion, sdkSupport, SUPPORTED_SDK } from "./sdk-support.value-object.ts";

describe("the SDK versions this binary runs", () => {
  test("say which side is behind for a version outside them", () => {
    const [major, minor] = SUPPORTED_SDK.from.split(".").map(Number);

    expect(sdkSupport(`${major}.${minor - 1}.9`)).toBe("older");
    expect(sdkSupport(`${major}.${minor}.3`)).toBe("supported");
    expect(sdkSupport(SUPPORTED_SDK.below)).toBe("newer");
    expect(sdkSupport(`${major + 1}.0.0`)).toBe("newer");
  });

  test("a pin names a version, exact or with a prefix, and never a range", () => {
    expect(pinnedVersion("0.6.0")).toEqual(Option.some("0.6.0"));
    expect(pinnedVersion("^0.6.1")).toEqual(Option.some("0.6.1"));
    expect(pinnedVersion(">=0.6.0")).toEqual(Option.none());
    expect(pinnedVersion("latest")).toEqual(Option.none());
  });
});
