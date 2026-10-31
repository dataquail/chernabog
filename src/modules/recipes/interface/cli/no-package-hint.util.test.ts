import { describe, expect, test } from "bun:test";

import { noPackageHint } from "./no-package-hint.util.ts";

describe("noPackageHint", () => {
  test("says how to install a recipe package when flows have none to compare with", () => {
    const [hint, ...rest] = noPackageHint(false, true);

    expect(rest).toEqual([]);
    expect(hint).toContain("chernabog init installs @chernabog/recipes");
  });

  test("says nothing once a package is installed", () => {
    expect(noPackageHint(true, true)).toEqual([]);
  });

  test("says nothing of a repo with no flows", () => {
    expect(noPackageHint(false, false)).toEqual([]);
  });
});
