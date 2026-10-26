import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { BUNDLED_SDK_VERSION } from "../../../../kernel/sdk-support.value-object.ts";
import { SeveralRunsInFlight } from "./run.errors.ts";
import { RunRoot } from "./run.root.ts";
import { RunRootOps } from "./run.root-ops.ts";

const at = "2026-10-22T00:00:00.000Z";
const later = "2026-10-22T01:00:00.000Z";

const asBob = {
  id: RunId.make("a"),
  sdkVersion: BUNDLED_SDK_VERSION,
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

  test("a running run links the pull request it opened", () => {
    expect(Result.getOrThrow(RunRootOps.linkPullRequest(running, 124)).pullRequest).toEqual(
      Option.some(124),
    );
    expect(running.pullRequest).toEqual(Option.none());
  });

  test("a run that ended takes no step, no execution, no pull request and no second ending", () => {
    for (const refused of [
      RunRootOps.enterStep(finished, "late"),
      RunRootOps.linkPullRequest(finished, 9),
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

describe("RunRootOps.cancel", () => {
  test("ends a running run as cancelled, saying who, when, and the step it interrupted", () => {
    const stepped = Result.getOrThrow(RunRootOps.enterStep(running, "await-closed:approved"));
    const cancelled = Result.getOrThrow(RunRootOps.cancel(stepped, "alice", later));

    expect([
      cancelled.status,
      cancelled.summary,
      cancelled.currentStep,
      cancelled.finishedAt,
    ]).toEqual([
      "cancelled",
      Option.some(`cancelled by alice at ${later}, interrupted in await-closed:approved`),
      Option.none(),
      Option.some(later),
    ]);
  });

  test("a run in no step says only who and when", () => {
    const cancelled = Result.getOrThrow(RunRootOps.cancel(running, "alice", later));

    expect(cancelled.summary).toEqual(Option.some(`cancelled by alice at ${later}`));
  });

  test("a run that ended, cancelled or not, can't be cancelled", () => {
    const cancelled = Result.getOrThrow(RunRootOps.cancel(running, "alice", later));

    for (const ended of [finished, cancelled]) {
      const refused = RunRootOps.cancel(ended, "alice", later);

      expect(Result.isFailure(refused) && refused.failure._tag).toBe("RunAlreadyFinished");
    }

    expect(Result.isFailure(RunRootOps.finish(cancelled, "failed", "interrupted", later))).toBe(
      true,
    );
  });
});

describe("RunRootOps.inFlightFor", () => {
  const query = {
    repo: "demo",
    itemKey: "pr-1",
    flow: Option.none<string>(),
    persona: Option.none<string>(),
  };

  const asAlice = Result.getOrThrow(
    RunRootOps.start(
      [],
      { ...asBob, id: RunId.make("b"), persona: Option.some("alice"), flow: "re-review" },
      at,
    ),
  );

  test("finds the one run in flight for the item, passing over ended ones", () => {
    expect(RunRootOps.inFlightFor([finished, running], query)).toEqual(Result.succeed(running));
  });

  test("several in flight fail, listing them, until the flow or persona narrows them", () => {
    const both = [running, asAlice];
    const several = RunRootOps.inFlightFor(both, query);

    expect(several).toEqual(
      Result.fail(
        new SeveralRunsInFlight({
          repo: "demo",
          itemKey: "pr-1",
          matching: [RunId.make("a"), RunId.make("b")],
        }),
      ),
    );
    expect(RunRootOps.inFlightFor(both, { ...query, flow: Option.some("re-review") })).toEqual(
      Result.succeed(asAlice),
    );
    expect(RunRootOps.inFlightFor(both, { ...query, persona: Option.some("bob") })).toEqual(
      Result.succeed(running),
    );
  });

  test("none in flight for the item fails", () => {
    for (const asked of [query, { ...query, itemKey: "pr-2" }, { ...query, repo: "other" }]) {
      const none = RunRootOps.inFlightFor([finished], asked);

      expect(Result.isFailure(none) && none.failure._tag).toBe("NoRunInFlight");
    }
  });
});

describe("RunRootOps.sharingTarget", () => {
  const on = (id: string, itemKey: string, fields: Partial<RunRoot> = {}) =>
    RunRoot.make({ ...running, id: RunId.make(id), itemKey, ...fields });

  test("a review and a re-review of one pull request share it, whatever their keys", () => {
    const review = on("review", "pr-1");
    const reReview = on("re-review", "pr-1-review-1", { flow: "re-review" });
    const addressing = on("address", "pr-1-changes-1", { persona: Option.some("alice") });

    expect(RunRootOps.sharingTarget([review, reReview, addressing], review)).toEqual([
      reReview,
      addressing,
    ]);
  });

  test("runs that ended, on another item or repo, or on an issue of the same number share nothing", () => {
    const review = on("review", "pr-1");

    const others = [
      on("ended", "pr-1-review-1", { status: "done" }),
      on("other-pull", "pr-2"),
      on("other-repo", "pr-1", { repo: "elsewhere" }),
      on("issue", "issue-1"),
    ];

    expect(RunRootOps.sharingTarget([review, ...others], review)).toEqual([]);
    expect(
      RunRootOps.sharingTarget([on("nightly-2", "nightly")], on("nightly", "nightly")),
    ).toEqual([]);
  });
});

describe("RunRootOps.unsupported", () => {
  test("a run in flight under an SDK this binary doesn't run mustn't resume, naming both", () => {
    const old = Result.getOrThrow(RunRootOps.start([], { ...asBob, sdkVersion: "0.5.0" }, at));

    expect(Option.getOrThrow(RunRootOps.unsupported(old))).toContain(
      "it started under @chernabog/sdk 0.5.0, and this chernabog runs @chernabog/sdk >=",
    );
    expect(RunRootOps.unsupported(running)).toEqual(Option.none());
  });

  test("one that has ended is nothing to resume", () => {
    const old = Result.getOrThrow(RunRootOps.start([], { ...asBob, sdkVersion: "0.5.0" }, at));
    const ended = Result.getOrThrow(RunRootOps.finish(old, "done", "merged", later));

    expect(RunRootOps.unsupported(ended)).toEqual(Option.none());
  });
});
