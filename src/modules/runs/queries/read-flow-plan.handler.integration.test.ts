import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { FlowPlan } from "../domain/plan/flow-plan.value-object.ts";
import { RunPlanEntity } from "../domain/plan/run-plan.entity.ts";
import { RunPlansRepository } from "../domain/plan/run-plans.repository.ts";
import { RunPlansRepositoryLive } from "../infrastructure/repositories/run-plans.repository-live.ts";
import { readFlowPlanHandler } from "./read-flow-plan.handler.ts";

const plan = FlowPlan.make({ flow: "review", subject: "pull-request", hash: "h1", steps: [] });

describe("readFlowPlanHandler", () => {
  effect("answers a plan a run started with by its hash, and none for a hash no run has", () =>
    Effect.gen(function* () {
      yield* (yield* RunPlansRepository).insertOne(
        RunPlanEntity.make({ runId: RunId.make("a"), hash: "h1", plan }),
      );

      const asJson = yield* Schema.encodeEffect(Schema.toCodecJson(FlowPlan))(plan);

      expect((yield* readFlowPlanHandler({ hash: "h1" })).plan).toEqual(Option.some(asJson));
      expect((yield* readFlowPlanHandler({ hash: "h2" })).plan).toEqual(Option.none());
    }).pipe(
      Effect.provide(RunPlansRepositoryLive.pipe(Layer.provideMerge(sqliteAfter(Effect.void)))),
    ),
  );
});
