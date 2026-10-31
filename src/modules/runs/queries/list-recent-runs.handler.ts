import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type ListRecentRunsPayload, RunList } from "./list-recent-runs.query.ts";

export const listRecentRunsHandler = Effect.fn("listRecentRunsHandler")(function* ({
  latest,
}: ListRecentRunsPayload) {
  // The latest `latest` runs, newest first. A limit and an order are no
  // predicate, so a spec can't say them: this read leaves the repository with
  // the queries task (#283), which reads state.db directly.
  const runs = Arr.take(
    Arr.reverse(yield* (yield* RunsRepository).findMany(RunSpecifications.all)),
    latest,
  );

  return RunList.make({ runs: runs.map((run) => RunView.make({ ...run })) });
});
