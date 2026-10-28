import { describe, expect, test } from "bun:test";

import { unreleased } from "../scripts/release-pr.ts";

const CONFIG = {
  packages: {
    ".": { "include-component-in-tag": false },
    "packages/sdk": { component: "sdk" },
    "packages/recipes": { component: "recipes" },
  },
};

const BEFORE = { ".": "0.9.0", "packages/sdk": "0.6.0", "packages/recipes": "0.0.0" };
const AFTER = { ".": "0.10.0", "packages/sdk": "0.7.0", "packages/recipes": "0.1.0" };

// A release PR's body as release-please writes it, with a release note of its own in each part.
const body = (note: string) => `:robot: I have created a release *beep* *boop*
---


<details><summary>0.10.0</summary>

## [0.10.0](https://github.com/dataquail/chernabog/compare/v0.9.0...v0.10.0) (2026-10-28)

### ⚠ BREAKING CHANGES

* ${note}
</details>

<details><summary>sdk: 0.7.0</summary>

## [0.7.0](https://github.com/dataquail/chernabog/compare/sdk-v0.6.0...sdk-v0.7.0) (2026-10-28)

### ⚠ BREAKING CHANGES

* ${note}
</details>

<details><summary>recipes: 0.1.0</summary>

## 0.1.0 (2026-10-28)

### Features

* recipes as packages
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please).
`;

describe("the release PR's body", () => {
  test("finds a section for each version the PR moves", () => {
    expect(
      unreleased(body("`chernabog cancel` deletes the claim ref"), CONFIG, BEFORE, AFTER),
    ).toEqual([]);
  });

  test("names a part whose section text such as <run> swallows, and the text", () => {
    expect(
      unreleased(body("`chernabog cancel <run>` deletes the claim ref"), CONFIG, BEFORE, AFTER),
    ).toEqual([
      "sdk 0.7.0: release-please finds no section for it in the release PR's body, so merging it would release no sdk 0.7.0. The body has text HTML reads as a tag (<run>): write it as &lt;…&gt; in the body, then check again.",
    ]);
  });

  test("reads the text written as &lt;run&gt; as text", () => {
    expect(
      unreleased(
        body("`chernabog cancel &lt;run&gt;` deletes the claim ref"),
        CONFIG,
        BEFORE,
        AFTER,
      ),
    ).toEqual([]);
  });

  test("asks nothing of a part whose version the PR leaves", () => {
    expect(
      unreleased(body("`chernabog cancel <run>` deletes the claim ref"), CONFIG, BEFORE, {
        ...AFTER,
        "packages/sdk": "0.6.0",
      }),
    ).toEqual([]);
  });
});
