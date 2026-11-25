import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { RunSpokeRoot } from "./run-spoke.root.ts";
import { RunSpokeSpecifications } from "./run-spoke.specification.ts";

const spoke = (runId: string, pid: number) =>
  RunSpokeRoot.make({
    runId: RunId.make(runId),
    pid,
    startedAt: Option.none(),
    hubPid: 1,
    hubStartedAt: Option.none(),
    foldedSeq: 0,
    ending: Option.none(),
  });

const spokes = [spoke("a", 10), spoke("b", 11)];

describe("RunSpokeSpecifications", () => {
  test("all holds of every spoke, and forRun of one run's", () => {
    expect(spokes.filter(RunSpokeSpecifications.all)).toEqual(spokes);
    expect(spokes.filter(RunSpokeSpecifications.forRun(RunId.make("b")))).toEqual([spokes[1]]);
    expect(RunSpokeSpecifications.forRun(RunId.make("b")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "b" }),
    );
  });
});
