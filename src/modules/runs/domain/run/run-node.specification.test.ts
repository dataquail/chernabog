import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { RunNodeEntity } from "./run-node.entity.ts";
import { RunNodeSpecifications } from "./run-node.specification.ts";

const mark = (runId: string, node: string) =>
  RunNodeEntity.make({
    runId: RunId.make(runId),
    mark: "node",
    node,
    round: Option.none(),
    lane: Option.none(),
    at: "2026-11-08T00:00:00Z",
    finishedAt: Option.none(),
    outcome: Option.none(),
  });

describe("RunNodeSpecifications", () => {
  test("forRun holds of one run's marks, as an Eq on runId", () => {
    const marks = [mark("a", "claim"), mark("b", "claim"), mark("a", "ci")];
    expect(marks.filter(RunNodeSpecifications.forRun(RunId.make("a")))).toEqual([
      marks[0],
      marks[2],
    ]);
    expect(RunNodeSpecifications.forRun(RunId.make("a")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "a" }),
    );
  });
});
