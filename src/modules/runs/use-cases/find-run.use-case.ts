import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { FoundRun, RunView } from "./run.result.ts";

// The run with this id, if there is one.
export const findRunUseCase = Effect.fn("findRunUseCase")(function* (runId: RunId) {
  const run = yield* (yield* RunsRepository).findOne(runId);

  return FoundRun.make({ run: Option.map(run, (found) => RunView.make({ ...found })) });
});
