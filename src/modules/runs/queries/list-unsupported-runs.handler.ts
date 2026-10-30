import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { UnsupportedRuns } from "./list-unsupported-runs.query.ts";

export const listUnsupportedRunsHandler = Effect.fn("listUnsupportedRunsHandler")(function* () {
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
