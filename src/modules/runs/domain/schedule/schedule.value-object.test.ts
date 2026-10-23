import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  chooseSchedule,
  cronProblem,
  nextTick,
  spreadMinute,
  withinHours,
} from "./schedule.value-object.ts";

const local = DateTime.zoneMakeLocal();

// A wall-clock time today, in this machine's zone.
const at = (clock: string) =>
  DateTime.toUtc(
    DateTime.makeZonedUnsafe(`2026-10-17T${clock}:00`, {
      timeZone: local,
      adjustForTimeZone: true,
    }),
  );

const localMinute = (time: DateTime.Utc) => DateTime.toParts(DateTime.setZone(time, local)).minute;

describe("schedules", () => {
  test("repos spread across the hour", () => {
    expect([0, 1, 2].map((index) => spreadMinute(index, 3))).toEqual([0, 20, 40]);
  });

  test("the next tick follows the cron expression, seconds included", () => {
    expect(Option.map(nextTick("17 * * * *", at("10:20")), localMinute)).toEqual(Option.some(17));
    expect(
      Option.map(
        nextTick("*/2 * * * * *", DateTime.makeUnsafe("2026-10-17T10:00:01Z")),
        DateTime.formatIso,
      ),
    ).toEqual(Option.some("2026-10-17T10:00:02.000Z"));
    expect(nextTick("not a schedule", at("10:00"))).toEqual(Option.none());
  });

  test("hours are local, and a range may wrap midnight", () => {
    expect(withinHours("09:00-18:00", at("12:30"))).toBe(true);
    expect(withinHours("09:00-18:00", at("18:00"))).toBe(false);
    expect(withinHours("22:00-07:00", at("23:15"))).toBe(true);
    expect(withinHours("22:00-07:00", at("06:59"))).toBe(true);
    expect(withinHours("22:00-07:00", at("12:00"))).toBe(false);
  });

  test("the most specific schedule set wins, else a minute spread across the repos", () => {
    const none = {
      flow: Option.none<string>(),
      persona: Option.none<string>(),
      module: Option.none<string>(),
      repo: Option.none<string>(),
    };

    expect(chooseSchedule({ ...none, repo: Option.some("5 * * * *") }, 0, 1)).toBe("5 * * * *");
    expect(
      chooseSchedule(
        { ...none, persona: Option.some("1 * * * *"), module: Option.some("2 * * * *") },
        0,
        1,
      ),
    ).toBe("1 * * * *");
    expect(chooseSchedule(none, 1, 3)).toBe("20 * * * *");
  });

  test("an expression that isn't cron says why", () => {
    expect(cronProblem("*/5 * * * *")).toEqual(Option.none());
    expect(Option.getOrElse(cronProblem("every hour"), () => "")).toContain(
      '"every hour" isn\'t a schedule',
    );
  });
});
