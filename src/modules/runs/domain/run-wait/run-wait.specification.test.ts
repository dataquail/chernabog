import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { RunWaitRoot } from "./run-wait.root.ts";
import { RunWaitSpecifications } from "./run-wait.specification.ts";

const wait = (runId: string, deferred: string) =>
  RunWaitRoot.make({
    runId: RunId.make(runId),
    signal: "ci",
    deferred,
    token: "t",
    parkedAt: Option.none(),
  });

const waits = [wait("a", "ci-1"), wait("b", "ci-2")];

describe("RunWaitSpecifications", () => {
  test("all holds of every wait, and forRun of one run's", () => {
    expect(waits.filter(RunWaitSpecifications.all)).toEqual(waits);
    expect(waits.filter(RunWaitSpecifications.forRun(RunId.make("b")))).toEqual([waits[1]]);
    expect(RunWaitSpecifications.forRun(RunId.make("b")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "b" }),
    );
  });
});
