import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunStepsRepository } from "../domain/ports/repositories/run-steps.repository.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunHistory, RunStep } from "./run-history.result.ts";
import { RunWait } from "./run-wait.result.ts";

// The steps a run has entered and the signals it waits on, for a person
// looking at where it has been.
export const readRunHistoryUseCase = Effect.fn("readRunHistoryUseCase")(function* (runId: RunId) {
  const steps = yield* (yield* RunStepsRepository).findAll(runId);
  const waits = yield* (yield* RunWaitsRepository).findAll(Option.some(runId));

  return RunHistory.make({
    steps: steps.map((step) => RunStep.make({ step: step.step, enteredAt: step.enteredAt })),
    waits: waits.map((wait) => RunWait.make({ ...wait })),
  });
});
