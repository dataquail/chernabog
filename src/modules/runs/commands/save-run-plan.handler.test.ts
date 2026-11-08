import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { FlowPlan } from "../domain/plan/flow-plan.value-object.ts";
import { RunPlanSpecifications } from "../domain/plan/run-plan.specification.ts";
import { RunPlansRepository } from "../domain/plan/run-plans.repository.ts";
import { RunPlansRepositoryFake } from "../infrastructure/repositories/run-plans.repository-fake.ts";
import { saveRunPlanHandler } from "./save-run-plan.handler.ts";

const planOf = (hash: string) => FlowPlan.make({ flow: "review", subject: "pr", hash, steps: [] });

const hashOf = (runId: RunId) =>
  Effect.gen(function* () {
    const found = yield* (yield* RunPlansRepository).findOne(RunPlanSpecifications.forRun(runId));

    return Option.map(found, (started) => started.hash);
  });

describe("saveRunPlanHandler", () => {
  effect("keeps the plan a run started with, and never another for it", () =>
    Effect.gen(function* () {
      const a = RunId.make("a");
      yield* saveRunPlanHandler({ runId: a, plan: planOf("first") });
      yield* saveRunPlanHandler({ runId: a, plan: planOf("edited") });

      expect(yield* hashOf(a)).toEqual(Option.some("first"));
      expect(yield* hashOf(RunId.make("b"))).toEqual(Option.none());
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunPlansRepositoryFake([])))),
  );
});
