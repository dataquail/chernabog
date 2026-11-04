// Following a run's log from the CLI: the daemon runs the engine, so it is
// the one asked whether the run has finished.

import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { daemonRunRow } from "../../../../interface/daemon/daemon.client.ts";
import { type RunId } from "../../../../kernel/run-id.id.ts";
import { type RunView } from "../../domain/run/run-view.value-object.ts";
import { type LogOfStep } from "../../queries/follow-run-log.query.ts";
import { RunLogsQueries } from "../../runs.query-handlers.ts";

// How often a followed log is read again.
const EVERY = "1 second";

const isRunning = (row: Option.Option<RunView>) =>
  Option.exists(row, (found) => found.status === "running");

// Where a follower reads next, and whether it has read at all.
type Reading = readonly [from: number, first: boolean];

// A run's log as it grows: what it holds now, then what it gains, each read
// as one piece without its trailing newline. It ends once `finished` does,
// with what the log gained last. Every piece read is streamed: whether the
// run has finished is asked before each read, never by interrupting one, so
// a run that finishes during a read (or had finished before the first) still
// gets the read after it, which takes the rest of its log.
// With `step`, only that step's lines.
export const followLog = <E, R>(
  runId: RunId,
  finished: Effect.Effect<unknown, E, R>,
  step: Option.Option<typeof LogOfStep.Type> = Option.none(),
) =>
  Effect.gen(function* () {
    const logs = yield* RunLogsQueries;

    // What the log gained since `from`, and where to read next.
    const read = (from: number) =>
      logs
        .FollowRunLogQuery({
          runId,
          from,
          ...Option.match(step, { onNone: () => ({}), onSome: (only) => ({ step: only }) }),
        })
        .pipe(Effect.map((gained) => [Option.toArray(gained.text), gained.next] as const));

    // One read, after waiting out the interval unless the run finishes first;
    // the last once it has.
    const next = (over: Deferred.Deferred<void, E>, [from, first]: Reading) =>
      Effect.gen(function* () {
        if (!first) {
          yield* Deferred.await(over).pipe(
            Effect.exit,
            Effect.timeoutOrElse({ duration: EVERY, orElse: () => Effect.void }),
          );
        }

        const done = yield* Deferred.isDone(over);
        const [pieces, after] = yield* read(from);

        if (done) {
          yield* Deferred.await(over);

          return [pieces, Option.none<Reading>()] as const;
        }

        return [pieces, Option.some<Reading>([after, false])] as const;
      });

    return Stream.unwrap(
      Effect.gen(function* () {
        const over = yield* Deferred.make<void, E>();
        yield* Effect.forkScoped(Deferred.into(Effect.asVoid(finished), over));

        return Stream.paginate<Reading, string, E>([0, true], (state) => next(over, state));
      }),
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
