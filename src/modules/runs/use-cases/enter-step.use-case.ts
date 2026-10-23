import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "./run.result.ts";

// A run entering a step, as its log reports it. A run that has ended takes no step.
export const enterStepUseCase = Effect.fn("enterStepUseCase")(function* (
  runId: RunId,
  step: string,
) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const changed = yield* Effect.fromResult(RunRootOps.enterStep(found.value, step));
  yield* runs.save(changed);

  return RunView.make({ ...changed });
});
