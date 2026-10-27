import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunWaitRoot } from "./run-wait.root.ts";
import { RunWaitRootOps } from "./run-wait.root-ops.ts";

const wait = (signal: string, deferred: string, runId = "a") =>
  RunWaitRoot.make({
    runId: RunId.make(runId),
    signal,
    deferred,
    token: "t",
    parkedAt: Option.none(),
  });

describe("RunWaitRootOps", () => {
  test("a wait's race is its deferred's name without the signal", () => {
    expect(RunWaitRootOps.raceOf(wait("approved", "approved:plan-1"))).toBe("plan-1");
    expect(RunWaitRootOps.raceOf(wait("pushed", "d1"))).toBe("d1");
  });

  test("the losers to a woken wait are the same run's other waits in its race", () => {
    const won = wait("approved", "approved:plan-1");
    const lost = wait("changes-requested", "changes-requested:plan-1");

    expect(
      RunWaitRootOps.losersTo(won, [
        won,
        lost,
        wait("approved", "approved:plan-2"),
        wait("changes-requested", "changes-requested:plan-1", "b"),
      ]),
    ).toEqual([lost]);
  });
});
