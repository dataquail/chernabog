import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { PassPacing, type UnfinishedPass } from "./pass-pacing.value-object.ts";

const at = Date.parse("2026-11-22T00:35:00Z");

const ended = (quick: number, endedAt = at): Option.Option<UnfinishedPass> =>
  Option.some({ endedAt, quick });

// What each of a run of unfinished passes waits, each arriving `gap` millis
// after the one before ended, and ending as soon as its wait is over.
const passes = (count: number, gap: number) => {
  let previous = Option.none<UnfinishedPass>();
  let now = at;
  const waits: Array<number> = [];

  for (let index = 0; index < count; index += 1) {
    const pass = PassPacing.next(previous, now);
    const wait = Option.getOrElse(pass.wait, () => 0);
    waits.push(wait);
    previous = Option.some({ endedAt: now + wait, quick: pass.quick });
    now += wait + gap;
  }

  return waits;
};

describe("PassPacing", () => {
  test("a first pass, or one after a pass that finished, starts at once", () => {
    expect(PassPacing.next(Option.none(), at)).toEqual({ quick: 0, wait: Option.none() });
  });

  test("a pass long after the last unfinished one starts at once and starts the count again", () => {
    expect(PassPacing.next(ended(30), at + 60_000)).toEqual({ quick: 0, wait: Option.none() });
  });

  test("ten quick restarts in a row start at once; the eleventh waits a second", () => {
    expect(PassPacing.next(ended(9), at + 10)).toEqual({ quick: 10, wait: Option.none() });
    expect(PassPacing.next(ended(10), at + 10)).toEqual({ quick: 11, wait: Option.some(1_000) });
  });

  test("a replay loop's passes wait twice as long each time, up to five minutes", () => {
    const waits = passes(30, 5);

    expect(waits.slice(0, 11)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(waits.slice(11, 15)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(waits.at(-1)).toBe(5 * 60 * 1_000);
  });

  test("passes a few seconds apart, as a durable clock wakes them, never wait", () => {
    expect(passes(50, 3_000).every((wait) => wait === 0)).toBe(true);
  });
});
