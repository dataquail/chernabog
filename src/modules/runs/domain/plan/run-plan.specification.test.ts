import { describe, expect, test } from "bun:test";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { FlowPlan } from "./flow-plan.value-object.ts";
import { RunPlanEntity } from "./run-plan.entity.ts";
import { RunPlanSpecifications } from "./run-plan.specification.ts";

const planOf = (hash: string) => FlowPlan.make({ flow: "review", subject: "pr", hash, steps: [] });

const started = (runId: string, hash: string) =>
  RunPlanEntity.make({ runId: RunId.make(runId), hash, plan: planOf(hash) });

describe("RunPlanSpecifications", () => {
  const plans = [started("a", "h1"), started("b", "h1"), started("c", "h2")];

  test("forRun holds of the plan one run started with, as an Eq on runId", () => {
    expect(plans.filter(RunPlanSpecifications.forRun(RunId.make("b")))).toEqual([plans[1]]);
    expect(RunPlanSpecifications.forRun(RunId.make("b")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "b" }),
    );
  });

  test("withHash holds of every run's copy of one plan, as an Eq on hash", () => {
    expect(plans.filter(RunPlanSpecifications.withHash("h1"))).toEqual([plans[0], plans[1]]);
    expect(RunPlanSpecifications.withHash("h1").criteria).toEqual(
      Criteria.Eq({ field: "hash", value: "h1" }),
    );
  });
});
