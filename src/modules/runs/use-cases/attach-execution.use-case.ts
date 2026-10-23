import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "./run.result.ts";

// The workflow execution the engine started for a run, recorded so it can be polled and resumed.
export const attachExecutionUseCase = Effect.fn("attachExecutionUseCase")(function* (
  runId: RunId,
  executionId: string,
) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const changed = yield* Effect.fromResult(RunRootOps.attachExecution(found.value, executionId));
  yield* runs.save(changed);

  return RunView.make({ ...changed });
});
