// When each flow's trigger runs: a cron expression, from the most specific
// setting there is, else a minute of the hour spread across the repos.

import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

// Repos fire at evenly spread minutes, so their ticks don't all land at once.
export const spreadMinute = (index: number, count: number) =>
  Math.floor((index * 60) / Math.max(count, 1));

// The schedules that can set a flow's: the persona's own for the flow, the
// persona's default, the flow module's, and the repo's, most specific first.
export type ScheduleSettings = {
  readonly flow: Option.Option<string>;
  readonly persona: Option.Option<string>;
  readonly module: Option.Option<string>;
  readonly repo: Option.Option<string>;
};

// The first schedule set, else a minute of the hour spread across `count`
// repos, this one at `index`.
export const chooseSchedule = (settings: ScheduleSettings, index: number, count: number) =>
  settings.flow.pipe(
    Option.orElse(() => settings.persona),
    Option.orElse(() => settings.module),
    Option.orElse(() => settings.repo),
    Option.getOrElse(() => `${spreadMinute(index, count)} * * * *`),
  );

export const parseSchedule = (expression: string) => Result.getSuccess(Cron.parse(expression));

// Why a cron expression isn't one, if it isn't.
export const cronProblem = (expression: string) =>
  Result.match(Cron.parse(expression), {
    onSuccess: () => Option.none<string>(),
    onFailure: (error) => Option.some(`"${expression}" isn't a schedule: ${error.message}`),
  });

export const nextTick = (expression: string, after: DateTime.Utc) =>
  Option.map(parseSchedule(expression), (cron) => DateTime.fromDateUnsafe(Cron.next(cron, after)));

const minutesOf = (clock: string) =>
  Option.map(
    Option.fromNullishOr(/^(\d{1,2}):(\d{2})$/.exec(clock.trim())),
    (match) => Number(match[1]) * 60 + Number(match[2]),
  );

const within = (minute: number, from: number, to: number) => {
  if (from <= to) {
    return minute >= from && minute < to;
  }

  return minute >= from || minute < to;
};

// "09:00-18:00", or one that wraps midnight such as "22:00-07:00". Local time.
export const withinHours = (range: string, now: DateTime.Utc) => {
  const [from = "", to = ""] = range.split("-");
  const local = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));
  const minute = local.hour * 60 + local.minute;

  return Option.match(Option.all([minutesOf(from), minutesOf(to)]), {
    onNone: () => true,
    onSome: ([start, end]) => within(minute, start, end),
  });
};
