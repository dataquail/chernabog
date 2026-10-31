import * as Effect from "effect/Effect";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { type ListRecentRunsPayload, RunList } from "./list-recent-runs.query.ts";

export const listRecentRunsHandler = Effect.fn("listRecentRunsHandler")(function* ({
  latest,
}: ListRecentRunsPayload) {
  const runs = yield* (yield* RunsRepository).findAll({ latest });

  return RunList.make({ runs: runs.map((run) => RunView.make({ ...run })) });
});
