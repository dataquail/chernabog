import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunView, UnsupportedRuns } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";

export const listUnsupportedRunsHandler = Effect.fn("listUnsupportedRunsHandler")(function* () {
  const running = yield* (yield* RunsRepository).findMany(RunSpecifications.running);

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
