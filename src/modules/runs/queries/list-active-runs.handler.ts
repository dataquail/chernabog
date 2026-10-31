import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { samePersona } from "../../../kernel/persona.value-object.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { ActiveRun } from "../domain/run/run-view.value-object.ts";
import { ActiveRuns, type ListActiveRunsPayload } from "./list-active-runs.query.ts";

const matches = (filter: Option.Option<string>, value: string) =>
  Option.match(filter, { onNone: () => true, onSome: (wanted) => wanted === value });

export const listActiveRunsHandler = Effect.fn("listActiveRunsHandler")(function* (
  filter: ListActiveRunsPayload,
) {
  const running = yield* (yield* RunsRepository).findAll({ running: true });
  const waits = yield* (yield* RunWaitsRepository).findAll(Option.none());

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
