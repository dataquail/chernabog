import { describe, expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import {
  breachOf,
  breachSummary,
  DEFAULT_SILENT_EXITS,
  DEFAULT_SPOKE_BOUNDS,
  parseByteSize,
  silentExitEnding,
  type SpokeMeasure,
} from "./spoke-bounds.value-object.ts";

const within: SpokeMeasure = {
  telemetry: 1_000_000,
  runLog: 10_000,
  phaseTime: Duration.minutes(20),
  idle: Duration.seconds(30),
  memory: Option.some(200_000_000),
};

const summaryOf = (measure: SpokeMeasure) =>
  Option.map(breachOf(measure, DEFAULT_SPOKE_BOUNDS), breachSummary);

describe("spoke bounds", () => {
  test("a spoke within every bound breaks none", () => {
    expect(summaryOf(within)).toEqual(Option.none());
  });

  test("a spoke at a bound, but not past it, breaks none", () => {
    expect(
      summaryOf({
        telemetry: 256_000_000,
        runLog: 32_000_000,
        phaseTime: Duration.hours(4),
        idle: Duration.minutes(30),
        memory: Option.some(2_000_000_000),
      }),
    ).toEqual(Option.none());
  });

  test("each bound, past its default, is named with what was measured and its limit", () => {
    expect(summaryOf({ ...within, telemetry: 300_000_000 })).toEqual(
      Option.some("ended past its telemetry bound: 300 MB over 256 MB"),
    );
    expect(summaryOf({ ...within, runLog: 40_000_000 })).toEqual(
      Option.some("ended past its run log bound: 40 MB over 32 MB"),
    );
    expect(summaryOf({ ...within, phaseTime: Duration.millis(14_400_500 + 5_000) })).toEqual(
      Option.some("ended past its phase time bound: 4h 5s over 4h"),
    );
    expect(summaryOf({ ...within, idle: Duration.minutes(31) })).toEqual(
      Option.some("ended past its idle bound: 31m over 30m"),
    );
    expect(summaryOf({ ...within, memory: Option.some(2_500_000_000) })).toEqual(
      Option.some("ended past its memory bound: 2.5 GB over 2 GB"),
    );
  });

  test("memory the OS couldn't say breaks nothing", () => {
    expect(summaryOf({ ...within, memory: Option.none() })).toEqual(Option.none());
  });

  test("a spoke past several bounds is ended for the first the ADR lists", () => {
    expect(
      summaryOf({ ...within, runLog: 40_000_000, idle: Duration.hours(1), telemetry: 1e9 }),
    ).toEqual(Option.some("ended past its telemetry bound: 1 GB over 256 MB"));
  });

  test("sizes are read as config writes them", () => {
    expect(parseByteSize("256 MB")).toEqual(Option.some(256_000_000));
    expect(parseByteSize("1.5GB")).toEqual(Option.some(1_500_000_000));
    expect(parseByteSize("512 KiB")).toEqual(Option.some(524_288));
    expect(parseByteSize("lots")).toEqual(Option.none());
    expect(parseByteSize("-3 MB")).toEqual(Option.none());
  });
});

describe("a run whose spoke exited before saying how it ended", () => {
  test("is interrupted, so its phase repeats, until the limit in a row, then failed", () => {
    expect(DEFAULT_SILENT_EXITS).toBe(3);
    expect([0, 1, 2, 5].map((before) => silentExitEnding(before, 3))).toEqual([
      { ending: "interrupted", silentExits: 1 },
      { ending: "interrupted", silentExits: 2 },
      { ending: "failed", silentExits: 3 },
      { ending: "failed", silentExits: 6 },
    ]);
  });

  test("with a limit of 1, fails the first time", () => {
    expect(silentExitEnding(0, 1)).toEqual({ ending: "failed", silentExits: 1 });
  });
});
