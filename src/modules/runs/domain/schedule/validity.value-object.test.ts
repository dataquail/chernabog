import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import { DEFAULT_VALIDITY_EVERY, noteCheckFailure, validityDue } from "./validity.value-object.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("validityDue", () => {
  test("is due when never checked, or once `every` has passed since the last check", () => {
    const last = Option.some(at("2026-10-27T10:00:00Z"));

    expect(validityDue(Option.none(), DEFAULT_VALIDITY_EVERY, at("2026-10-27T10:00:00Z"))).toBe(
      true,
    );
    expect(validityDue(last, Duration.minutes(5), at("2026-10-27T10:04:59Z"))).toBe(false);
    expect(validityDue(last, Duration.minutes(5), at("2026-10-27T10:05:00Z"))).toBe(true);
  });
});

describe("noteCheckFailure", () => {
  test("counts failures in a row and keeps the last message", () => {
    const first = noteCheckFailure(Option.none(), "rate limited");

    expect(first).toEqual({ count: 1, message: "rate limited" });
    expect(noteCheckFailure(Option.some(first), "timed out")).toEqual({
      count: 2,
      message: "timed out",
    });
  });
});
