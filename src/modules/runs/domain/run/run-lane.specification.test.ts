import { describe, expect, test } from "bun:test";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { RunLaneEntity } from "./run-lane.entity.ts";
import { RunLaneSpecifications } from "./run-lane.specification.ts";

const lane = (runId: string, name: string) =>
  RunLaneEntity.make({ runId: RunId.make(runId), lane: name, needs: [] });

describe("RunLaneSpecifications", () => {
  const lanes = [lane("a", "task-1"), lane("b", "task-1"), lane("a", "task-2")];

  test("forRun holds of one run's lanes, as an Eq on runId", () => {
    expect(lanes.filter(RunLaneSpecifications.forRun(RunId.make("a")))).toEqual([
      lanes[0],
      lanes[2],
    ]);
    expect(RunLaneSpecifications.forRun(RunId.make("a")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "a" }),
    );
  });

  test("named holds of one lane of one run", () => {
    expect(lanes.filter(RunLaneSpecifications.named(RunId.make("a"), "task-1"))).toEqual([
      lanes[0],
    ]);
  });
});
