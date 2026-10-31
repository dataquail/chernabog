// Following a run's log from the CLI: the daemon runs the engine, so it is
// the one asked whether the run has finished.

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsQueries, type RunView } from "../../../modules/runs/runs.platform.ts";
import { daemonRunRow } from "../../daemon/daemon.client.ts";

// How often a followed log is read again.
const EVERY = "1 second";

const isRunning = (row: Option.Option<RunView>) =>
  Option.exists(row, (found) => found.status === "running");

// A run's log as it grows: what it holds now, then what it gains, each read
// as one piece without its trailing newline. It ends once `finished` does,
// with what the log gained last.
export const followLog = <E, R>(runId: RunId, finished: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const logs = yield* RunLogsQueries;
    const offset = yield* Ref.make(0);

    // What the log gained since the last read. A read finishes once begun, so
    // ending the stream mid-read loses nothing.
    const fresh = Effect.gen(function* () {
      const gained = yield* logs.FollowRunLogQuery({ runId, from: yield* Ref.get(offset) });
      yield* Ref.set(offset, gained.next);

      return Option.toArray(gained.text);
    }).pipe(Effect.uninterruptible);

    return Stream.fromEffectSchedule(fresh, Schedule.spaced(EVERY)).pipe(
      Stream.interruptWhen(finished),
      Stream.concat(Stream.fromEffect(fresh)),
      Stream.flattenIterable,
    );
  });

// Prints a run's log as it grows, until the daemon says the run has finished.
// Returns the run as it finished.
export const followRunLog = (runId: RunId) =>
  Effect.gen(function* () {
    const last = yield* Ref.make(Option.none<RunView>());

    const finished = daemonRunRow(runId).pipe(
      Effect.tap((row) => Ref.set(last, row)),
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), while: isRunning }),
    );

    yield* (yield* followLog(runId, finished)).pipe(Stream.runForEach((text) => Console.log(text)));

    return yield* Ref.get(last);
  });
