import { expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import { parseDuration } from "./repo-config.ts";

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
