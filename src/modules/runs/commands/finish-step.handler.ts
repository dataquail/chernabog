import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunEvents } from "../domain/run/run.events.ts";
import { RunStepEntity } from "../domain/run/run-step.entity.ts";
import { RunStepSpecifications } from "../domain/run/run-step.specification.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { type FinishStepPayload } from "./finish-step.command.ts";

export const finishStepHandler = Effect.fn("finishStepHandler")(
  function* ({ outcome, runId, step }: FinishStepPayload) {
    const steps = yield* RunStepsRepository;

    // An entry a step ended already keeps its end: a step ends once.
    const open = Arr.findLast(
      yield* steps.findMany(RunStepSpecifications.forRun(runId)),
      (entered) => entered.step === step && Option.isNone(entered.finishedAt),
    );

    if (Option.isNone(open)) {
      return;
    }

    const finishedAt = DateTime.formatIso(yield* DateTime.now);

    yield* steps.updateOne(
      RunStepEntity.make({
        ...open.value,
        finishedAt: Option.some(finishedAt),
        outcome: Option.some(outcome),
      }),
    );

    yield* (yield* EventBus).dispatch([
      RunEvents.finishedStep({ runId, step, outcome, finishedAt }),
    ]);
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
