import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { RunStepEntity } from "./run-step.entity.ts";
import { RunStepSpecifications } from "./run-step.specification.ts";

const step = (runId: string, name: string) =>
  RunStepEntity.make({
    runId: RunId.make(runId),
    step: name,
    enteredAt: "2026-10-20T00:00:00Z",
    finishedAt: Option.none(),
    outcome: Option.none(),
  });

describe("RunStepSpecifications", () => {
  test("forRun holds of one run's steps, as an Eq on runId", () => {
    const steps = [step("a", "implement"), step("b", "implement"), step("a", "ci")];
    expect(steps.filter(RunStepSpecifications.forRun(RunId.make("a")))).toEqual([
      steps[0],
      steps[2],
    ]);
    expect(RunStepSpecifications.forRun(RunId.make("a")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "a" }),
    );
  });
});
