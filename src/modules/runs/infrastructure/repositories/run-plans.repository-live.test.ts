import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowPlan } from "../../domain/plan/flow-plan.value-object.ts";
import { RunPlanEntity } from "../../domain/plan/run-plan.entity.ts";
import { RunPlanSpecifications } from "../../domain/plan/run-plan.specification.ts";
import { RunPlansRepository } from "../../domain/plan/run-plans.repository.ts";
import { RunPlansRepositoryLive } from "./run-plans.repository-live.ts";

const planOf = (hash: string) =>
  FlowPlan.make({
    flow: "review",
    subject: "pull-request",
    hash,
    steps: [
      {
        id: "review",
        path: "steps[0]",
        kind: "use",
        block: "review.round",
        in: { pr: "trigger.pr" },
        with: {},
        branches: [
          {
            outcome: "approve",
            steps: [
              {
                id: "steps[0].on.approve.steps[0]",
                path: "steps[0].on.approve.steps[0]",
                kind: "end",
                end: "done",
              },
            ],
          },
        ],
      },
    ],
  });

const startedWith = (runId: string, hash: string) =>
  RunPlanEntity.make({ runId: RunId.make(runId), hash, plan: planOf(hash) });

const Count = Schema.Array(Schema.Struct({ plans: Schema.Finite }));

describe("RunPlansRepositoryLive", () => {
  effect("keeps each plan once by its hash, and each run the plan it started with", () =>
    Effect.gen(function* () {
      const plans = yield* RunPlansRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* plans.insertOne(startedWith("a", "h1"));
      yield* plans.insertOne(startedWith("b", "h1"));
      yield* plans.insertOne(startedWith("c", "h2"));
      // A run that has a plan keeps it.
      yield* plans.insertOne(startedWith("a", "h2"));

      expect(yield* plans.findOne(RunPlanSpecifications.forRun(RunId.make("a")))).toEqual(
        Option.some(startedWith("a", "h1")),
      );
      expect(
        Option.map(
          yield* plans.findOne(RunPlanSpecifications.withHash("h1")),
          (found) => found.plan,
        ),
      ).toEqual(Option.some(planOf("h1")));
      expect(yield* plans.findOne(RunPlanSpecifications.withHash("h3"))).toEqual(Option.none());
      expect(yield* plans.findOne(RunPlanSpecifications.forRun(RunId.make("d")))).toEqual(
        Option.none(),
      );

      // Two runs of one plan share one copy of it.
      const counted = yield* sql`SELECT count(*) AS plans FROM om_plans`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Count)),
      );

      expect(counted).toEqual([{ plans: 2 }]);
    }).pipe(
      Effect.provide(RunPlansRepositoryLive.pipe(Layer.provideMerge(sqliteAfter(Effect.void)))),
    ),
  );
});
