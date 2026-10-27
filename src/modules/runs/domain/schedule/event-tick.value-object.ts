// Ticks an event asks for, besides cron's: a run here changed something, or a
// persona's GitHub notifications have news. An event never decides what a tick
// does; it only makes a persona's flow due sooner, through the same tick.

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

// A tick an event asked for, not run yet: the first event's cause and when it
// came, and how many more it covers.
export type PendingTick = {
  readonly cause: string;
  readonly since: DateTime.Utc;
  readonly more: number;
};

// How long a burst of events has to settle into one tick.
export const EVENT_SETTLE = Duration.seconds(3);

// The least time between two event ticks of one persona's flow, by default.
export const DEFAULT_EVENT_TICK_MIN = Duration.seconds(30);

// An event added to what's pending. The first one's cause and time stand, so
// a burst makes one tick, and one event after another can't keep putting it off.
export const noteEvent = (
  pending: Option.Option<PendingTick>,
  cause: string,
  at: DateTime.Utc,
): PendingTick =>
  Option.match(pending, {
    onNone: () => ({ cause, since: at, more: 0 }),
    onSome: (found) => ({ ...found, more: found.more + 1 }),
  });

// When a pending tick runs: once its burst has settled, and no sooner than
// `min` after the flow's last event tick.
export const eventTickAt = (
  pending: PendingTick,
  lastEventTick: Option.Option<DateTime.Utc>,
  min: Duration.Duration,
): DateTime.Utc => {
  const settled = DateTime.addDuration(pending.since, EVENT_SETTLE);

  return Option.match(lastEventTick, {
    onNone: () => settled,
    onSome: (last) => DateTime.max(settled, DateTime.addDuration(last, min)),
  });
};

// What a pending tick says made it: its first event, and how many more.
export const causeOf = (pending: PendingTick) => {
  if (pending.more === 0) {
    return pending.cause;
  }

  return `${pending.cause} (+${pending.more} more)`;
};

// What a local change reads as in a tick's cause: the work item it was on, if any.
export const localCause = (what: string, item: Option.Option<number>) =>
  Option.match(item, {
    onNone: () => `local: ${what}`,
    onSome: (number) => `local: #${number} ${what}`,
  });

// What a notification reads as in a tick's cause.
export const notificationCause = (reason: string, item: Option.Option<number>) =>
  Option.match(item, {
    onNone: () => `notification: ${reason}`,
    onSome: (number) => `notification: ${reason} on #${number}`,
  });
