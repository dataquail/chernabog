import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { StepColumns, toEntity } from "./run-step.mapper.ts";

describe("the run step mapper", () => {
  test("an om_steps row reads back as the step its run entered, and how it ended", () => {
    const row = Schema.decodeSync(StepColumns)({
      run_id: "run-1",
      step: "ci",
      entered_at: "2026-10-20T00:01:00.000Z",
      finished_at: "2026-10-20T00:02:00.000Z",
      outcome: "failed",
    });

    expect(toEntity(row)).toEqual(
      RunStepEntity.make({
        runId: RunId.make("run-1"),
        step: "ci",
        node: Option.none(),
        enteredAt: "2026-10-20T00:01:00.000Z",
        finishedAt: Option.some("2026-10-20T00:02:00.000Z"),
        outcome: Option.some("failed"),
      }),
    );
  });

  test("a row missing a column isn't a step", () => {
    expect(() => Schema.decodeUnknownSync(StepColumns)({ run_id: "run-1", step: "ci" })).toThrow();
  });
});
