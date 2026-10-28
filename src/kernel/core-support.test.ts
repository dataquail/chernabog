import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import {
  BUNDLED_CORE_VERSION,
  coreSupport,
  pinnedVersion,
  resumesRunsFrom,
} from "./core-support.value-object.ts";

describe("the core this binary provides", () => {
  const [major, minor] = BUNDLED_CORE_VERSION.split(".").map(Number);

  test("serves every range that admits it, and says which side is behind for one that doesn't", () => {
    expect(coreSupport(`^${major}.0.0`)).toBe("supported");
    expect(coreSupport(`^${BUNDLED_CORE_VERSION}`)).toBe("supported");
    expect(coreSupport(`^${major - 1}.0.0 || ^${major}.0.0`)).toBe("supported");
    // An SDK that needs a later minor than this binary has, or a later major.
    expect(coreSupport(`^${major}.${minor + 1}.0`)).toBe("newer");
    expect(coreSupport(`^${major + 1}.0.0`)).toBe("newer");
    // An SDK written for a major this binary no longer provides.
    expect(coreSupport(`^${major - 1}.0.0`)).toBe("older");
  });

  test("resumes a run started under its major, at its version or before", () => {
    expect(resumesRunsFrom(`${major}.0.0`)).toBe(true);
    expect(resumesRunsFrom(BUNDLED_CORE_VERSION)).toBe(true);
    expect(resumesRunsFrom(`${major}.${minor + 1}.0`)).toBe(false);
    expect(resumesRunsFrom(`${major + 1}.0.0`)).toBe(false);
    // Runs from before core, which recorded the all-in-one SDK they started under.
    expect(resumesRunsFrom("0.7.0")).toBe(false);
    expect(resumesRunsFrom("not a version")).toBe(false);
  });

  test("a pin names a version, exact or with a prefix, and never a range", () => {
    expect(pinnedVersion("0.6.0")).toEqual(Option.some("0.6.0"));
    expect(pinnedVersion("^0.6.1")).toEqual(Option.some("0.6.1"));
    expect(pinnedVersion(">=0.6.0")).toEqual(Option.none());
    expect(pinnedVersion("latest")).toEqual(Option.none());
  });
});
