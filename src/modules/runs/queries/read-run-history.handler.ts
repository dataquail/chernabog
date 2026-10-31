import * as Effect from "effect/Effect";

import { RunHistory, RunStep } from "../domain/run/run-history.value-object.ts";
import { RunStepSpecifications } from "../domain/run/run-step.specification.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type ReadRunHistoryPayload } from "./read-run-history.query.ts";

export const readRunHistoryHandler = Effect.fn("readRunHistoryHandler")(function* ({
  runId,
}: ReadRunHistoryPayload) {
  const steps = yield* (yield* RunStepsRepository).findMany(RunStepSpecifications.forRun(runId));
  const waits = yield* (yield* RunWaitsRepository).findMany(RunWaitSpecifications.forRun(runId));

  return RunHistory.make({
    steps: steps.map((step) => RunStep.make({ step: step.step, enteredAt: step.enteredAt })),
    waits: waits.map((wait) => RunWait.make({ ...wait })),
  });
});
