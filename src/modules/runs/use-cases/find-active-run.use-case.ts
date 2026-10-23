import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { FoundRun, RunView } from "./run.result.ts";

// A persona's run of a repo's flow on one work item.
export type RunOf = {
  readonly repo: string;
  readonly persona: Persona;
  readonly flow: string;
  readonly itemKey: string;
};

// The persona's run in flight for the item, if it has one: a persona has at
// most one per flow and item.
export const findActiveRunUseCase = Effect.fn("findActiveRunUseCase")(function* (wanted: RunOf) {
  const running = yield* (yield* RunsRepository).findAll({ running: true });

  return FoundRun.make({
    run: Option.map(RunRootOps.activeFor(running, wanted), (run) => RunView.make({ ...run })),
  });
});
