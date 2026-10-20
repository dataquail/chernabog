// When each flow's trigger runs, and whether a run may start now.

import type { Flow } from '@chernabog/sdk';
import * as Cron from 'effect/Cron';
import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';

import type { EffectiveRepo } from './repo-config.ts';

// Repos fire at evenly spread minutes, so their ticks don't all land at once.
export const spreadMinute = (index: number, count: number) => Math.floor((index * 60) / Math.max(count, 1));

// The flow's own setting in local.yaml, then the person's default, then the
// team's: the flow's setting in config.yaml, the flow module's, the repo's.
export const scheduleFor = (repo: EffectiveRepo, flowName: string, flow: Flow, index: number, count: number) =>
  Record.get(repo.flows, flowName).pipe(
    Option.flatMap((settings) => Option.fromUndefinedOr(settings.schedule)),
    Option.orElse(() => repo.schedule.local),
    Option.orElse(() => Option.fromUndefinedOr(flow.schedule)),
    Option.orElse(() => repo.schedule.repo),
    Option.getOrElse(() => `${spreadMinute(index, count)} * * * *`),
  );

export const parseSchedule = (expression: string) => Result.getSuccess(Cron.parse(expression));

export const nextTick = (expression: string, after: DateTime.Utc) =>
  Option.map(parseSchedule(expression), (cron) => DateTime.fromDateUnsafe(Cron.next(cron, after)));

const minutesOf = (clock: string) =>
  Option.map(Option.fromNullishOr(/^(\d{1,2}):(\d{2})$/.exec(clock.trim())), (match) => Number(match[1]) * 60 + Number(match[2]));

const within = (minute: number, from: number, to: number) => {
  if (from <= to) return minute >= from && minute < to;

  return minute >= from || minute < to;
};

// "09:00-18:00", or one that wraps midnight such as "22:00-07:00". Local time.
export const withinHours = (range: string, now: DateTime.Utc) => {
  const [from = '', to = ''] = range.split('-');
  const local = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));
  const minute = local.hour * 60 + local.minute;

  return Option.match(Option.all([minutesOf(from), minutesOf(to)]), {
    onNone: () => true,
    onSome: ([start, end]) => within(minute, start, end),
  });
};

export type Capacity = {
  readonly activeForFlow: number;
  readonly flowConcurrency: number;
  readonly activeOnMachine: number;
  readonly machineConcurrency: number;
};

export type TickDecision = { readonly go: true } | { readonly go: false; readonly reason: string };

export type TickConditions = {
  readonly enabled: boolean;
  // Why the flow doesn't run on this machine, if it doesn't.
  readonly flowOff: Option.Option<string>;
  readonly paused: boolean;
  readonly quietHours: Option.Option<string>;
  readonly activeHours: Option.Option<string>;
  readonly now: DateTime.Utc;
};

const stop = (reason: string): TickDecision => ({ go: false, reason });

// The machine's limits, checked before a flow's trigger and its own gate.
export const decideTick = (conditions: TickConditions): TickDecision => {
  if (!conditions.enabled) return stop('disabled in local.yaml');

  if (Option.isSome(conditions.flowOff)) return stop(conditions.flowOff.value);

  if (conditions.paused) return stop('paused');

  const quiet = Option.filter(conditions.quietHours, (hours) => withinHours(hours, conditions.now));

  if (Option.isSome(quiet)) return stop(`quiet hours (${quiet.value})`);

  const outside = Option.filter(conditions.activeHours, (hours) => !withinHours(hours, conditions.now));

  if (Option.isSome(outside)) return stop(`outside active hours (${outside.value})`);

  return { go: true };
};

export const freeSlots = (capacity: Capacity) => Math.max(0, Math.min(capacity.flowConcurrency - capacity.activeForFlow, capacity.machineConcurrency - capacity.activeOnMachine));
