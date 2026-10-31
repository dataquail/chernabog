import * as Option from "effect/Option";

import { type RunRoot } from "./run.root.ts";

// How long a run's log outlives the run, in days: from when the run finished,
// as state.db says; for a log no run in state.db has, from when it was last
// written.
export const RUN_LOG_RETENTION_DAYS = 30;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// Whether a log is past its retention at `now` (epoch millis), given its run,
// none for a log whose run state.db doesn't have, and when the log was last
// written. A run still running, which a parked run or one that needs
// attention is, keeps its log however old it is.
const expired = (run: Option.Option<RunRoot>, modifiedAt: number, now: number) => {
  const oldestKept = now - RUN_LOG_RETENTION_DAYS * MILLIS_PER_DAY;

  return Option.match(run, {
    onNone: () => modifiedAt < oldestKept,
    onSome: (found) =>
      found.status !== "running" &&
      Option.exists(found.finishedAt, (at) => Date.parse(at) < oldestKept),
  });
};

export const RunLogRetention = { expired } as const;
