import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunRoot } from "./run.root.ts";
import { RunRootOps } from "./run.root-ops.ts";

const at = "2026-10-22T00:00:00.000Z";
const later = "2026-10-22T01:00:00.000Z";

const asBob = {
  id: RunId.make("a"),
  repo: "demo",
  persona: Option.some("bob"),
  flow: "review",
  itemKey: "pr-1",
  itemTitle: Option.none(),
  itemUrl: Option.none(),
};

const running = Result.getOrThrow(RunRootOps.start([], asBob, at));

const finished = Result.getOrThrow(RunRootOps.finish(running, "done", "merged", later));

describe("RunRootOps.start", () => {
  test("a run starts running, in no step, with no execution yet", () => {
    expect(running).toEqual(
      RunRoot.make({
        ...asBob,
        executionId: Option.none(),
        status: "running",
        currentStep: Option.none(),
        summary: Option.none(),
        startedAt: at,
        finishedAt: Option.none(),
      }),
    );
  });

  test("a persona has one run in flight per flow and item", () => {
    const again = RunRootOps.start([running], { ...asBob, id: RunId.make("b") }, later);

    expect(Result.isFailure(again) && again.failure.runId).toBe(RunId.make("a"));
  });

  test("another persona, another item, or a run that ended doesn't stop one starting", () => {
    const others = [
      { ...asBob, id: RunId.make("b"), persona: Option.some("alice") },
      { ...asBob, id: RunId.make("c"), persona: Option.none() },
      { ...asBob, id: RunId.make("d"), itemKey: "pr-2" },
    ];

    for (const other of others) {
      expect(Result.isSuccess(RunRootOps.start([running], other, later))).toBe(true);
    }

    expect(Result.isSuccess(RunRootOps.start([finished], asBob, later))).toBe(true);
  });
});

describe("RunRootOps lifecycle", () => {
  test("a running run takes an execution and steps", () => {
    const stepped = Result.getOrThrow(
      Result.flatMap(RunRootOps.attachExecution(running, "x"), (run) =>
        RunRootOps.enterStep(run, "implement"),
      ),
    );

    expect([stepped.executionId, stepped.currentStep]).toEqual([
      Option.some("x"),
      Option.some("implement"),
    ]);
  });

  test("finishing records how and when it ended, and leaves it in no step", () => {
    const stepped = Result.getOrThrow(RunRootOps.enterStep(running, "implement"));
    const ended = Result.getOrThrow(RunRootOps.finish(stepped, "needs-human", "stuck", later));

    expect([ended.status, ended.summary, ended.currentStep, ended.finishedAt]).toEqual([
      "needs-human",
      Option.some("stuck"),
      Option.none(),
      Option.some(later),
    ]);
  });

  test("a run that ended takes no step, no execution and no second ending", () => {
    for (const refused of [
      RunRootOps.enterStep(finished, "late"),
      RunRootOps.attachExecution(finished, "y"),
      RunRootOps.finish(finished, "failed", "again", later),
    ]) {
      expect(Result.isFailure(refused) && refused.failure._tag).toBe("RunAlreadyFinished");
    }
  });
});

describe("RunRootOps.adopt", () => {
  test("gives a run from before personas the persona, and leaves one with a persona alone", () => {
    const implicit = RunRoot.make({ ...running, persona: Option.none() });

    expect(Option.map(RunRootOps.adopt(implicit, "alice"), (run) => run.persona)).toEqual(
      Option.some(Option.some("alice")),
    );
    expect(RunRootOps.adopt(running, "alice")).toEqual(Option.none());
  });
});

describe("RunRootOps.activeFor", () => {
  test("finds the persona's run in flight for the item, not one that ended", () => {
    const wanted = { repo: "demo", persona: Option.some("bob"), flow: "review", itemKey: "pr-1" };

    expect(RunRootOps.activeFor([finished, running], wanted)).toEqual(Option.some(running));
    expect(RunRootOps.activeFor([finished], wanted)).toEqual(Option.none());
    expect(RunRootOps.activeFor([running], { ...wanted, persona: Option.none() })).toEqual(
      Option.none(),
    );
  });
});
