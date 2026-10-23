import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";

// How often a followed log is read again.
const EVERY = "1 second";

// A run's log as it grows: what it holds now, then what it gains, each read
// as one piece without its trailing newline. It ends once `finished` does,
// with what the log gained last. Who can tell that a run has finished, the
// daemon or this process's engine, is the caller's to say.
export const followRunLogUseCase = Effect.fn("followRunLogUseCase")(function* <E, R>(
  runId: RunId,
  finished: Effect.Effect<unknown, E, R>,
) {
  const logs = yield* RunLogsClient;
  const offset = yield* Ref.make(0);

  // What the log gained since the last read. A read finishes once begun, so
  // ending the stream mid-read loses nothing.
  const fresh = Effect.gen(function* () {
    const from = yield* Ref.get(offset);
    const gained = Option.getOrElse(yield* logs.readFrom(runId, from), () => "");
    yield* Ref.set(offset, from + gained.length);

    return Option.toArray(Option.liftPredicate(gained.trimEnd(), (text) => text.length > 0));
  }).pipe(Effect.uninterruptible);

  return Stream.fromEffectSchedule(fresh, Schedule.spaced(EVERY)).pipe(
    Stream.interruptWhen(finished),
    Stream.concat(Stream.fromEffect(fresh)),
    Stream.flattenIterable,
  );
});
