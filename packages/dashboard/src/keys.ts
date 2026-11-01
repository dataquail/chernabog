// What a key does on the overview: `j` and `k` move through the runs, active
// ones first, `enter` opens the selected one, and `/` focuses the filter.

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

export type KeyAction =
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "open"; readonly runId: string }
  | { readonly kind: "focus-filter" }
  | { readonly kind: "none" };

const NONE: KeyAction = { kind: "none" };

// The runs as the overview lists them: in flight, then recent.
export const runOrder = (status: DaemonStatus): ReadonlyArray<string> =>
  [...status.active, ...status.recent].map((run) => run.id);

// Where a move starts with nothing selected: just above the first run for `j`,
// just below the last for `k`.
const outside = (runs: ReadonlyArray<string>, by: number) => {
  if (by > 0) {
    return -1;
  }

  return runs.length;
};

const moved = (runs: ReadonlyArray<string>, selected: Option.Option<number>, by: number) => {
  if (runs.length === 0) {
    return NONE;
  }

  const from = Option.getOrElse(selected, () => outside(runs, by));

  const index = Math.min(Math.max(from + by, 0), runs.length - 1);

  return { kind: "select", index } satisfies KeyAction;
};

export const onKey = (
  key: string,
  runs: ReadonlyArray<string>,
  selected: Option.Option<number>,
): KeyAction => {
  switch (key) {
    case "j":
      return moved(runs, selected, 1);
    case "k":
      return moved(runs, selected, -1);
    case "Enter":
      return Option.match(
        Option.flatMap(selected, (index) => Option.fromUndefinedOr(runs[index])),
        {
          onNone: () => NONE,
          onSome: (runId): KeyAction => ({ kind: "open", runId }),
        },
      );
    case "/":
      return { kind: "focus-filter" };
    default:
      return NONE;
  }
};
