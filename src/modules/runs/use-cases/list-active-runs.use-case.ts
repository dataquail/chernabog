import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Persona, samePersona } from "../../../kernel/persona.value-object.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { ActiveRun, ActiveRuns } from "./run.result.ts";

// Which runs in flight to list: each set field narrows them.
export type ActiveRunsFilter = {
  readonly repo: Option.Option<string>;
  readonly persona: Option.Option<Persona>;
  readonly flow: Option.Option<string>;
};

const matches = (filter: Option.Option<string>, value: string) =>
  Option.match(filter, { onNone: () => true, onSome: (wanted) => wanted === value });

// The runs in flight, oldest first, each with whether it's parked on a
// signal, so it holds no slot.
export const listActiveRunsUseCase = Effect.fn("listActiveRunsUseCase")(function* (
  filter: ActiveRunsFilter,
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
