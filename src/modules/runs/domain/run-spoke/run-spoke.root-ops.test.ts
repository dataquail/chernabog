import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunSpokeRoot } from "./run-spoke.root.ts";
import { RunSpokeRootOps } from "./run-spoke.root-ops.ts";

const spoke = RunSpokeRoot.make({
  runId: RunId.make("a"),
  pid: 42,
  startedAt: Option.some("Wed Nov 25 10:00:00 2026"),
  hubPid: 7,
  hubStartedAt: Option.none(),
  foldedSeq: 3,
  ending: Option.none(),
});

const cancel = { by: "alice", closeSessions: false, endAs: Option.none() };

const bound = {
  by: "chernabog",
  closeSessions: true,
  endAs: Option.some({ ending: "failed" as const, reason: "past its idle bound" }),
};

describe("RunSpokeRootOps", () => {
  test("the fold position moves on, never back", () => {
    expect(RunSpokeRootOps.advance(spoke, 5).foldedSeq).toBe(5);
    expect(RunSpokeRootOps.advance(spoke, 2).foldedSeq).toBe(3);
  });

  test("the first ending meant for a spoke is the one it keeps", () => {
    const cancelled = RunSpokeRootOps.intend(spoke, cancel);

    expect(cancelled.ending).toEqual(Option.some(cancel));
    expect(RunSpokeRootOps.intend(cancelled, bound).ending).toEqual(Option.some(cancel));
    expect(RunSpokeRootOps.intend(spoke, bound).ending).toEqual(Option.some(bound));
  });
});
