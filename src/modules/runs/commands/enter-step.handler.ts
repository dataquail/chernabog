import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunStepsRepository } from "../domain/ports/repositories/run-steps.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { RunStepRoot } from "../domain/run-step/run-step.root.ts";
import { type EnterStepPayload } from "./enter-step.command.ts";

export const enterStepHandler = Effect.fn("enterStepHandler")(function* ({
  runId,
  step,
}: EnterStepPayload) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const changed = yield* Effect.fromResult(RunRootOps.enterStep(found.value, step));
  yield* runs.save(changed);
  yield* (yield* RunStepsRepository).save(
    RunStepRoot.make({ runId, step, enteredAt: DateTime.formatIso(yield* DateTime.now) }),
  );

  return RunView.make({ ...changed });
});
