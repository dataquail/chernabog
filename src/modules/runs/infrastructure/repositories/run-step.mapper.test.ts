import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { StepColumns, toEntity } from "./run-step.mapper.ts";

describe("the run step mapper", () => {
  test("an om_steps row reads back as the step its run entered", () => {
    const row = Schema.decodeSync(StepColumns)({
      run_id: "run-1",
      step: "ci",
      entered_at: "2026-10-20T00:01:00.000Z",
    });

    expect(toEntity(row)).toEqual(
      RunStepEntity.make({
        runId: RunId.make("run-1"),
        step: "ci",
        enteredAt: "2026-10-20T00:01:00.000Z",
      }),
    );
  });

  test("a row missing a column isn't a step", () => {
    expect(() => Schema.decodeUnknownSync(StepColumns)({ run_id: "run-1", step: "ci" })).toThrow();
  });
});
