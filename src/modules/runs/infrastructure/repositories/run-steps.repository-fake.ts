import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunStepRoot } from "../../domain/run-step/run-step.root.ts";
import { RunStepsRepository } from "../../domain/run-step/run-steps.repository.ts";

// Steps in memory, starting from `steps`.
export const RunStepsRepositoryFake = (steps: ReadonlyArray<RunStepRoot>) =>
  Layer.effect(
    RunStepsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(steps);

      return RunStepsRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        insertOne: (step: RunStepRoot) => Ref.update(store, (stored) => [...stored, step]),
      });
    }),
  );
