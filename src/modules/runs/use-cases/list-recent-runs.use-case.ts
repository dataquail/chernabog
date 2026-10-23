import * as Effect from "effect/Effect";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunList, RunView } from "./run.result.ts";

// The latest runs, newest first, finished or not.
export const listRecentRunsUseCase = Effect.fn("listRecentRunsUseCase")(function* (latest: number) {
  const runs = yield* (yield* RunsRepository).findAll({ latest });

  return RunList.make({ runs: runs.map((run) => RunView.make({ ...run })) });
});
