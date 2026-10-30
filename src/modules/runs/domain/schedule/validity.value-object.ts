// When the daemon asks whether a repo's runs in flight still have their work
// item, and what it keeps of a run whose check keeps failing. A check that
// fails never ends a run; it only shows.

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import { itemTarget } from "../run/work-item.value-object.ts";

// How often each run in flight is checked, by default: the team's limits.validityEvery.
export const DEFAULT_VALIDITY_EVERY = Duration.minutes(5);

// Whether a repo's runs are due a check at `now`: never checked, or `every`
// has passed since the last one.
export const validityDue = (
  last: Option.Option<DateTime.Utc>,
  every: Duration.Duration,
  now: DateTime.Utc,
) =>
  Option.match(last, {
    onNone: () => true,
    onSome: (at) => DateTime.isLessThanOrEqualTo(DateTime.addDuration(at, every), now),
  });

// A run's checks that failed in a row, and the last one's message.
export type CheckFailures = { readonly count: number; readonly message: string };

// One more failed check of a run.
export const noteCheckFailure = (
  previous: Option.Option<CheckFailures>,
  message: string,
): CheckFailures => ({
  count: Option.match(previous, { onNone: () => 1, onSome: (found) => found.count + 1 }),
  message,
});

// Whether a run in flight is about the issue or pull request a notification
// names: its item is that one, or it named that one as a subject.
export const runIsAbout = (
  run: { readonly itemKey: string; readonly subjects: ReadonlyArray<string> },
  number: number,
) =>
  [run.itemKey, ...run.subjects].some((key) =>
    Option.exists(itemTarget(key), (target) => target.number === number),
  );
