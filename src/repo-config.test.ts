import { expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DEFAULT_SPOKE_BOUNDS } from "./kernel/spoke-bounds.value-object.ts";
import { MachineConfigFile, normalizeMachineConfig, parseDuration } from "./repo-config.ts";

const millisOf = (text: string) => Option.map(parseDuration(text), Duration.toMillis);

test("each unit parses, singular and plural", () => {
  const cases: ReadonlyArray<readonly [string, Duration.Duration]> = [
    ["1 milli", Duration.millis(1)],
    ["500 millis", Duration.millis(500)],
    ["1 second", Duration.seconds(1)],
    ["30 seconds", Duration.seconds(30)],
    ["1 minute", Duration.minutes(1)],
    ["90 minutes", Duration.minutes(90)],
    ["1 hour", Duration.hours(1)],
    ["6 hours", Duration.hours(6)],
    ["1 day", Duration.days(1)],
    ["2 days", Duration.days(2)],
    ["1 week", Duration.weeks(1)],
    ["2 weeks", Duration.weeks(2)],
  ];

  expect(cases.map(([text]) => millisOf(text))).toEqual(
    cases.map(([, duration]) => Option.some(Duration.toMillis(duration))),
  );
});

test("a decimal amount parses", () => {
  expect(millisOf("1.5 hours")).toEqual(Option.some(Duration.toMillis(Duration.minutes(90))));
});

test("surrounding whitespace is ignored, and the space before the unit is optional", () => {
  expect(millisOf("  6 hours  ")).toEqual(Option.some(Duration.toMillis(Duration.hours(6))));
  expect(millisOf("6hours")).toEqual(Option.some(Duration.toMillis(Duration.hours(6))));
});

test("anything else is not a duration", () => {
  const rejected = ["", "hours", "6", "-1 hours", "6 months", "6 Hours"];

  expect(rejected.map(parseDuration)).toEqual(rejected.map(() => Option.none()));
});

const machineFrom = (file: typeof MachineConfigFile.Encoded) =>
  normalizeMachineConfig(Schema.decodeSync(MachineConfigFile)(file), "/home/me");

test("a spoke's bounds are the defaults unless machine config's spokes: sets them", () => {
  expect(machineFrom({}).spokes).toEqual(DEFAULT_SPOKE_BOUNDS);

  const set = machineFrom({
    spokes: { telemetry: "64 MB", runLog: "2 MB", phaseTime: "90 minutes", idle: "5 minutes" },
  }).spokes;

  expect(set.telemetry).toBe(64_000_000);
  expect(set.runLog).toBe(2_000_000);
  expect(Duration.toMinutes(set.phaseTime)).toBe(90);
  expect(Duration.toMinutes(set.idle)).toBe(5);
  expect(set.memory).toBe(DEFAULT_SPOKE_BOUNDS.memory);
});

test("a spoke's silent exits in a row are 3 unless machine config's spokes: sets them", () => {
  expect(machineFrom({}).silentExits).toBe(3);
  expect(machineFrom({ spokes: { silentExits: 5 } }).silentExits).toBe(5);
  expect(() => machineFrom({ spokes: { silentExits: 0 } })).toThrow();
});

test("a spoke bound machine config can't read is refused, naming what it wants", () => {
  expect(() => machineFrom({ spokes: { memory: "a lot" } })).toThrow(
    '"a lot" is not a size, such as "256 MB"',
  );
  expect(() => machineFrom({ spokes: { idle: "soon" } })).toThrow(
    '"soon" is not a duration, such as "6 hours"',
  );
});
