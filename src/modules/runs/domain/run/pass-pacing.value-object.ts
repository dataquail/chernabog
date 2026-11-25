import * as Option from "effect/Option";

// How soon a run's workflow may start its next pass in this process (#611).
// The engine replays a workflow whose pass ended interrupted without a result
// at once, with no delay of its own, so a pass that keeps ending that way
// replays many times a second and does no work. A pass that starts soon after
// such a pass counts as a quick restart; after enough in a row, each next pass
// waits, longer each time, up to a bound. A pass that ends any other way, or a
// restart that comes late, starts the count again.
//
// A suspension ends a pass as an interrupt too, so a healthy run that
// suspends and is woken within the window more than `freeRestarts` times in a
// row is slowed as well. No flow does that today: durable sleeps and waits are
// longer, and a run woken that often is better slowed than not.

// The last pass of an execution that ended without a result: when it ended
// (epoch millis), and how many quick restarts in a row came before it.
export type UnfinishedPass = { readonly endedAt: number; readonly quick: number };

export type NextPass = {
  // The quick restarts in a row this pass makes; 0 for one that isn't quick.
  readonly quick: number;
  // How long it waits before it starts, in millis; none to start at once.
  readonly wait: Option.Option<number>;
};

export const PASS_PACING = {
  // A pass that starts within this long of the one before ended is quick.
  quickWithinMillis: 2_000,
  // How many quick restarts in a row pass before one waits.
  freeRestarts: 10,
  // The first wait, doubled at each quick restart after it, up to the longest.
  firstWaitMillis: 1_000,
  longestWaitMillis: 5 * 60 * 1_000,
} as const;

// The pass of an execution that starts at `now`, after its last unfinished
// pass, none when the one before it finished or there was none.
const next = (previous: Option.Option<UnfinishedPass>, now: number): NextPass => {
  const quick = Option.match(
    Option.filter(previous, (pass) => now - pass.endedAt < PASS_PACING.quickWithinMillis),
    { onNone: () => 0, onSome: (pass) => pass.quick + 1 },
  );

  const wait = Option.map(
    Option.liftPredicate(quick - PASS_PACING.freeRestarts, (over) => over > 0),
    (over) =>
      Math.min(PASS_PACING.firstWaitMillis * 2 ** (over - 1), PASS_PACING.longestWaitMillis),
  );

  return { quick, wait };
};

export const PassPacing = { next } as const;
