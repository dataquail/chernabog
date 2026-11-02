import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { RunStepsRepository } from "../../domain/run/run-steps.repository.ts";

// Whether two are the same entry of a run into a step.
const sameEntry = (left: RunStepEntity, right: RunStepEntity) =>
  left.runId === right.runId && left.step === right.step && left.enteredAt === right.enteredAt;

// Steps in memory, starting from `steps`.
export const RunStepsRepositoryFake = (steps: ReadonlyArray<RunStepEntity>) =>
  Layer.effect(
    RunStepsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(steps);

      return RunStepsRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        insertOne: (step: RunStepEntity) => Ref.update(store, (stored) => [...stored, step]),
        updateOne: (step: RunStepEntity) =>
          Ref.update(store, (stored) =>
            stored.map((each) => {
              if (sameEntry(each, step)) {
                return step;
              }

              return each;
            }),
          ),
      });
    }),
  );
