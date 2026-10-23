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
  item: Option.none(),
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

  test("a running run with no execution is one a crash interrupted before it started", () => {
    const attached = Result.getOrThrow(RunRootOps.attachExecution(running, "x"));

    expect(RunRootOps.unexecuted(running)).toEqual(Option.some(running));
    expect(RunRootOps.unexecuted(attached)).toEqual(Option.none());
    expect(RunRootOps.unexecuted(finished)).toEqual(Option.none());
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

describe("RunRootOps.named", () => {
  const FIRST = RunId.make("3f2a9c1e-7b4d-4e8a-9c2f-1d5e6a7b8c9d");
  const SECOND = RunId.make("3f2b0000-0000-4000-8000-000000000000");
  const OLD = RunId.make("demo.implement.issue-7.20261021-120000");
  const ids = [SECOND, OLD, FIRST];

  test("a prefix that names one run is enough, as is the whole id", () => {
    expect(RunRootOps.named(ids, "3f2a")).toEqual(Result.succeed(FIRST));
    expect(RunRootOps.named(ids, FIRST)).toEqual(Result.succeed(FIRST));
    expect(RunRootOps.named(ids, "demo.implement")).toEqual(Result.succeed(OLD));
  });

  test("a prefix that names several runs, or none, is refused", () => {
    const several = RunRootOps.named(ids, "3f2");
    const none = RunRootOps.named(ids, "ffff");

    expect(Result.isFailure(several) && several.failure.message).toBe(
      `3f2 names 2 runs (${FIRST}, ${SECOND}); give more of the id`,
    );
    expect(Result.isFailure(none) && none.failure.message).toBe("no run ffff");
  });
});
