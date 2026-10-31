import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunStepsRepository } from "../domain/ports/repositories/run-steps.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { RunStepRoot } from "../domain/run-step/run-step.root.ts";
import { type EnterStepPayload } from "./enter-step.command.ts";

export const enterStepHandler = Effect.fn("enterStepHandler")(
  function* ({ runId, step }: EnterStepPayload) {
    const runs = yield* RunsRepository;
    const found = yield* runs.findOne(runId);

    if (Option.isNone(found)) {
      return yield* new RunNotFound({ runId });
    }

    const changed = yield* Effect.fromResult(RunRootOps.enterStep(found.value, step));
    const steps = yield* RunStepsRepository;
    // A resumed run re-enters the step it was in when it stopped, and that
    // step's event went out the first time.
    const again = (yield* steps.findAll(runId)).some((entered) => entered.step === step);

    const entered = RunStepRoot.make({
      runId,
      step,
      enteredAt: DateTime.formatIso(yield* DateTime.now),
    });

    yield* runs.save(changed);
    yield* steps.save(entered);

    if (!again) {
      yield* (yield* EventBus).dispatch([RunEvents.enteredStep(runId, step, entered.enteredAt)]);
    }

    return RunView.make({ ...changed });
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
