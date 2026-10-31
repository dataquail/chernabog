import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunStepsRepository } from "../domain/ports/repositories/run-steps.repository.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunHistory, RunStep } from "../domain/run/run-history.value-object.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { type ReadRunHistoryPayload } from "./read-run-history.query.ts";

export const readRunHistoryHandler = Effect.fn("readRunHistoryHandler")(function* ({
  runId,
}: ReadRunHistoryPayload) {
  const steps = yield* (yield* RunStepsRepository).findAll(runId);
  const waits = yield* (yield* RunWaitsRepository).findAll(Option.some(runId));

  return RunHistory.make({
    steps: steps.map((step) => RunStep.make({ step: step.step, enteredAt: step.enteredAt })),
    waits: waits.map((wait) => RunWait.make({ ...wait })),
  });
});
