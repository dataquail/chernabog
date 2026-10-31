import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepsRepository } from "../../domain/ports/repositories/run-steps.repository.ts";
import { type RunStepEntity } from "../../domain/run/run-step.entity.ts";

// Steps in memory, starting from `steps`.
export const RunStepsRepositoryFake = (steps: ReadonlyArray<RunStepEntity>) =>
  Layer.effect(
    RunStepsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(steps);

      return RunStepsRepository.of({
        findAll: (runId: RunId) =>
          Ref.get(store).pipe(
            Effect.map((stored) => stored.filter((step) => step.runId === runId)),
          ),
        save: (step: RunStepEntity) => Ref.update(store, (stored) => [...stored, step]),
      });
    }),
  );
