// How long a run computed for: the time at least one of its steps covers, with
// steps that overlap (a forEach's lanes) counted once, not summed. A domain
// service, since it reads no aggregate: it takes the steps a run entered (from
// om_steps), when the run finished, and now.
//
// Parked waits and durable sleeps (CI polling) fall between steps, so they
// count for nothing; no wait is read. A step's interval runs from its entry to
// its finish, or, for a step that was interrupted and has none, to the next
// entry of the same step, else the run's finish, else now. A run with no steps
// recorded, one from before steps were kept, has no compute time, not zero.

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

// A step a run entered, as om_steps keeps it: ISO timestamps, and no finish
// while it runs or once it was interrupted.
export type StepSpan = {
  readonly step: string;
  readonly enteredAt: string;
  readonly finishedAt: Option.Option<string>;
};

type Interval = { readonly start: number; readonly end: number };

const millis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const byStart = Order.mapInput(Order.Number, (each: { readonly start: number }) => each.start);

// Where each step ends: its finish, else the next entry of the same step,
// else the run's finish, else now.
const intervalsOf = (steps: ReadonlyArray<StepSpan>, fallback: number): ReadonlyArray<Interval> => {
  const entered = Arr.sort(
    steps.map((step) => ({ step: step.step, start: millis(step.enteredAt), span: step })),
    byStart,
  );

  return entered.map((each, index) => {
    const end = Option.getOrElse(
      Option.orElse(Option.map(each.span.finishedAt, millis), () =>
        Option.map(
          Arr.findFirst(
            entered.slice(index + 1),
            (later) => later.step === each.step && later.start >= each.start,
          ),
          (later) => later.start,
        ),
      ),
      () => fallback,
    );

    return { start: each.start, end: Math.max(each.start, end) };
  });
};

// The length of the intervals' union: sorted by start, each adds only what
// reaches past the furthest end so far.
const unionLength = (intervals: ReadonlyArray<Interval>) =>
  Arr.sort(intervals, byStart).reduce(
    (covered, interval) => ({
      length: covered.length + Math.max(0, interval.end - Math.max(interval.start, covered.reach)),
      reach: Math.max(covered.reach, interval.end),
    }),
    { length: 0, reach: Number.NEGATIVE_INFINITY },
  ).length;

// A run's compute time in milliseconds; none for a run with no steps recorded.
const of = (run: {
  readonly steps: ReadonlyArray<StepSpan>;
  readonly runFinishedAt: Option.Option<string>;
  readonly now: string;
}): Option.Option<number> =>
  Option.map(Arr.match(run.steps, { onEmpty: Option.none, onNonEmpty: Option.some }), (steps) =>
    unionLength(intervalsOf(steps, millis(Option.getOrElse(run.runFinishedAt, () => run.now)))),
  );

export const ComputeTime = { of } as const;
