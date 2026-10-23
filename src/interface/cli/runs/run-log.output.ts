// Following a run's log from the CLI: the daemon runs the engine, so it is
// the one asked whether the run has finished.

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { followRunLogUseCase } from "../../../modules/runs/use-cases/follow-run-log.use-case.ts";
import { type RunView } from "../../../modules/runs/use-cases/run.result.ts";
import { daemonRunRow } from "../../daemon/daemon.client.ts";

const isRunning = (row: Option.Option<RunView>) =>
  Option.exists(row, (found) => found.status === "running");

// Prints a run's log as it grows, until the daemon says the run has finished.
// Returns the run as it finished.
export const followRunLog = (runId: RunId) =>
  Effect.gen(function* () {
    const last = yield* Ref.make(Option.none<RunView>());

    const finished = daemonRunRow(runId).pipe(
      Effect.tap((row) => Ref.set(last, row)),
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), while: isRunning }),
    );

    yield* (yield* followRunLogUseCase(runId, finished)).pipe(
      Stream.runForEach((text) => Console.log(text)),
    );

    return yield* Ref.get(last);
  });
