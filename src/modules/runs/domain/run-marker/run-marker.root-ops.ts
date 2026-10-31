// The rules a marker keeps. A run holds a name and arguments once: holding it
// again changes nothing while it is held. Once the run ends, each held
// marker is kept, if the run ended in one of its keepOn endings, or released,
// newest first; a release that fails is tried again later, backing off from
// thirty seconds to an hour.

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { RunMarkerRoot } from "./run-marker.root.ts";

export type Holding = {
  readonly runId: RunId;
  readonly name: string;
  readonly args: Schema.Json;
  readonly keepOn: ReadonlyArray<string>;
};

const FIRST_RETRY = Duration.seconds(30);
const LAST_RETRY = Duration.hours(1);

const printArgs = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

// The arguments as one line of JSON, which tells two holds of a name apart.
const argsText = (args: Schema.Json) => printArgs(args);

// Whether two holds are the same name and arguments of one run.
const same = (left: Holding, right: Holding) =>
  left.runId === right.runId &&
  left.name === right.name &&
  argsText(left.args) === argsText(right.args);

const hold = (holding: Holding, at: string) =>
  RunMarkerRoot.make({
    ...holding,
    keepOn: [...holding.keepOn],
    status: "held",
    heldAt: at,
    attempts: 0,
    lastError: Option.none(),
    nextAttemptAt: Option.none(),
    settledAt: Option.none(),
  });

// The marker to save for a hold: none when the run already holds it, so a
// run that resumes doesn't hold it twice; held anew when it was let go.
const holdAgain = (
  existing: Option.Option<RunMarkerRoot>,
  holding: Holding,
  at: string,
): Option.Option<RunMarkerRoot> =>
  Option.match(existing, {
    onNone: () => Option.some(hold(holding, at)),
    onSome: (found) => {
      if (found.status === "held") {
        return Option.none();
      }

      return Option.some(hold(holding, at));
    },
  });

// Whether the marker stays on this ending. A run that lost its item keeps
// every marker: they are the new holder's now.
const keptOn = (marker: RunMarkerRoot, ending: string) =>
  ending === "lost" || marker.keepOn.includes(ending);

// Whether a held marker's release may be tried at `now`.
const isDue = (marker: RunMarkerRoot, now: DateTime.Utc) =>
  marker.status === "held" &&
  Option.match(marker.nextAttemptAt, {
    onNone: () => true,
    onSome: (next) =>
      Option.match(DateTime.make(next), {
        onNone: () => true,
        onSome: (at) => DateTime.isLessThanOrEqualTo(at, now),
      }),
  });

const settled = (marker: RunMarkerRoot, status: "released" | "kept", at: string) =>
  RunMarkerRoot.make({
    ...marker,
    status,
    nextAttemptAt: Option.none(),
    settledAt: Option.some(at),
  });

const released = (marker: RunMarkerRoot, at: string) => settled(marker, "released", at);

const kept = (marker: RunMarkerRoot, at: string) => settled(marker, "kept", at);

const unreleasable = (marker: RunMarkerRoot, reason: string, at: string) =>
  RunMarkerRoot.make({
    ...marker,
    status: "unreleasable",
    lastError: Option.some(reason),
    nextAttemptAt: Option.none(),
    settledAt: Option.some(at),
  });

// How long after its `attempts`th failure a release is tried again.
const backoff = (attempts: number) =>
  Duration.min(Duration.times(FIRST_RETRY, 2 ** Math.max(0, attempts - 1)), LAST_RETRY);

// A release that failed: still held, tried again after a backoff.
const failed = (marker: RunMarkerRoot, reason: string, now: DateTime.Utc) => {
  const attempts = marker.attempts + 1;

  return RunMarkerRoot.make({
    ...marker,
    attempts,
    lastError: Option.some(reason),
    nextAttemptAt: Option.some(DateTime.formatIso(DateTime.addDuration(now, backoff(attempts)))),
  });
};

// A run's markers newest first, the order they're released in, from the order they were held.
const releaseOrder = (markers: ReadonlyArray<RunMarkerRoot>) => markers.toReversed();

const SWEEP_GRACE = Duration.minutes(15);

const leftToSweep = (_marker: RunMarkerRoot, _endedAt: Option.Option<string>, _now: DateTime.Utc) =>
  true;

const untried = (_marker: RunMarkerRoot) => true;

export const RunMarkerRootOps = {
  SWEEP_GRACE,
  leftToSweep,
  untried,
  argsText,
  same,
  hold,
  holdAgain,
  keptOn,
  isDue,
  released,
  kept,
  unreleasable,
  backoff,
  failed,
  releaseOrder,
};
