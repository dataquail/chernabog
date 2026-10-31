import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { samePersona } from "../../../kernel/persona.value-object.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { ActiveRun } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { ActiveRuns, type ListActiveRunsPayload } from "./list-active-runs.query.ts";

const matches = (filter: Option.Option<string>, value: string) =>
  Option.match(filter, { onNone: () => true, onSome: (wanted) => wanted === value });

export const listActiveRunsHandler = Effect.fn("listActiveRunsHandler")(function* (
  filter: ListActiveRunsPayload,
) {
  const running = yield* (yield* RunsRepository).findMany(RunSpecifications.running);
  const waits = yield* (yield* RunWaitsRepository).findMany(RunWaitSpecifications.all);

  return ActiveRuns.make({
    runs: running
      .filter(
        (run) =>
          matches(filter.repo, run.repo) &&
          Option.match(filter.persona, {
            onNone: () => true,
            onSome: (wanted) => samePersona(wanted, run.persona),
          }) &&
          matches(filter.flow, run.flow),
      )
      .map((run) =>
        ActiveRun.make({ ...run, parked: waits.some((wait) => wait.runId === run.id) }),
      ),
  });
});
