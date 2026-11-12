// doctor's folder-trust check (#465): Claude opens a git checkout, and its
// worktrees wherever they are, without asking only when the checkout's own
// path is trusted. A trusted folder above it doesn't count.

import { describe, expect, test } from "bun:test";

import { trustsCheckout } from "../src/interface/cli/doctor.main.ts";

const trusted = { hasTrustDialogAccepted: true };

describe("doctor's folder-trust check", () => {
  test("a checkout trusted by its own path is trusted", () => {
    expect(trustsCheckout({ "/code/demo": trusted }, "/code/demo")).toBe(true);
  });

  test("a trusted folder above the checkout isn't enough", () => {
    expect(trustsCheckout({ "/code": trusted }, "/code/demo")).toBe(false);
  });

  test("a checkout whose trust was declined, or never asked, isn't trusted", () => {
    expect(trustsCheckout({ "/code/demo": { hasTrustDialogAccepted: false } }, "/code/demo")).toBe(
      false,
    );
    expect(trustsCheckout({ "/code/demo": {} }, "/code/demo")).toBe(false);
    expect(trustsCheckout({}, "/code/demo")).toBe(false);
  });
});
