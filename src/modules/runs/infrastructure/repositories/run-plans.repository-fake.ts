import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunPlanEntity } from "../../domain/plan/run-plan.entity.ts";
import { RunPlansRepository } from "../../domain/plan/run-plans.repository.ts";

// Runs' plans in memory, starting from `plans`. A run keeps the plan it has.
export const RunPlansRepositoryFake = (plans: ReadonlyArray<RunPlanEntity>) =>
  Layer.effect(
    RunPlansRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(plans);

      return RunPlansRepository.of({
        findOne: (spec) => Ref.get(store).pipe(Effect.map((stored) => Arr.findFirst(stored, spec))),
        insertOne: (started: RunPlanEntity) =>
          Ref.update(store, (stored) => {
            if (stored.some((each) => each.runId === started.runId)) {
              return stored;
            }

            return [...stored, started];
          }),
      });
    }),
  );
