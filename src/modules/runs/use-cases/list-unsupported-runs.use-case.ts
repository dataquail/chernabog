import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView, UnsupportedRuns } from "./run.result.ts";

// The runs in flight, executing or parked on a signal, that started under an
// SDK this binary doesn't run, each with why it mustn't resume: what a
// composition root sends to a person at startup, rather than replay.
export const listUnsupportedRunsUseCase = Effect.fn("listUnsupportedRunsUseCase")(function* () {
  const running = yield* (yield* RunsRepository).findAll({ running: true });

  return UnsupportedRuns.make({
    runs: running.flatMap((run) =>
      Option.toArray(
        Option.map(RunRootOps.unsupported(run), (reason) => ({
          run: RunView.make({ ...run }),
          reason,
        })),
      ),
    ),
  });
});
