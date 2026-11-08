import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunPlanEntity } from "../domain/plan/run-plan.entity.ts";
import { RunPlanSpecifications } from "../domain/plan/run-plan.specification.ts";
import { RunPlansRepository } from "../domain/plan/run-plans.repository.ts";
import { type SaveRunPlanPayload } from "./save-run-plan.command.ts";

export const saveRunPlanHandler = Effect.fn("saveRunPlanHandler")(
  function* ({ plan, runId }: SaveRunPlanPayload) {
    const plans = yield* RunPlansRepository;

    if (Option.isSome(yield* plans.findOne(RunPlanSpecifications.forRun(runId)))) {
      return;
    }

    yield* plans.insertOne(RunPlanEntity.make({ runId, hash: plan.hash, plan }));
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
