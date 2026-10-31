import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { CancelTarget, type EndAs } from "../domain/run/cancelled-run.value-object.ts";
import { RunFinished } from "../domain/run/run.events.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import {
  type FakeHoldings,
  fakeHoldings,
  RunCleanupClientFake,
} from "../infrastructure/clients/run-cleanup.client-fake.ts";
import { RunLogsClientFake } from "../infrastructure/clients/run-logs.client-fake.ts";
import {
  type FakeEngine,
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { cancelRunHandler } from "./cancel-run.handler.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const finished = run("done-1", {
  status: "done",
  summary: Option.some("merged"),
  finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
});

const wait = (runId: string, deferred: string) =>
  RunWaitRoot.make({
    runId: RunId.make(runId),
    signal: "closed",
    deferred,
    token: "t",
    parkedAt: Option.none(),
  });

// An engine whose interrupted executions end at once, as the real one does.
const stoppingEngine = (...ids: ReadonlyArray<string>) => {
  const engine = fakeEngine();

  for (const id of ids) {
    engine.outcomes[`execution-${id}`] = { status: "failed", summary: "interrupted" };
  }

  return engine;
};

const runtime = (
  engine: FakeEngine,
  holdings: FakeHoldings,
  stored: { readonly runs: ReadonlyArray<RunRoot>; readonly waits?: ReadonlyArray<RunWaitRoot> },
) =>
  Layer.mergeAll(
    RecordedEvents,
    RunsRepositoryFake(stored.runs),
    RunWaitsRepositoryFake(stored.waits ?? []),
    RunLogsClientFake(Object.fromEntries(stored.runs.map((one) => [one.id, ""]))),
    WorkflowsClientFake(engine),
    RunCleanupClientFake(holdings),
  );

const byId = (asked: string) => CancelTarget.cases.ById.make({ asked });
const asAlice = { by: "alice", closeSessions: false, endAs: Option.none<EndAs>() };

const statusOf = (id: string) =>
  findRunHandler({ runId: RunId.make(id) }).pipe(
    Effect.map((found) => Option.map(found.run, (one) => one.status)),
  );

describe("cancelRunHandler", () => {
  const engine = stoppingEngine("a");
  const holdings = fakeHoldings();

  effect("ends a waiting run as cancelled, clears its waits and interrupts its workflow", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("a"), ...asAlice });

      expect(cancelled.run.status).toBe("cancelled");
      expect(Option.getOrThrow(cancelled.run.summary)).toMatch(
        /^cancelled by alice at .*, interrupted in await-closed:approved$/,
      );
      expect([cancelled.stopped, cancelled.wakesCleared]).toEqual([true, 2]);
      expect(engine.interrupted).toEqual(["execution-a"]);
      expect(engine.notes).toEqual([`a: ${Option.getOrThrow(cancelled.run.summary)}`]);
      expect(
        (yield* (yield* RunWaitsRepository).findMany(RunWaitSpecifications.all)).map(
          (left) => left.runId,
        ),
      ).toEqual([RunId.make("other")]);
      // A pull request's run holds no claim.
      expect([holdings.cleaned, holdings.released]).toEqual([["a"], []]);
      expect(yield* statusOf("a")).toEqual(Option.some("cancelled"));
      expect(yield* DispatchedEvents).toEqual([
        RunFinished.make({
          eventId: "a:finished",
          runId: RunId.make("a"),
          status: "cancelled",
          summary: Option.getOrThrow(cancelled.run.summary),
          finishedAt: Option.getOrThrow(cancelled.run.finishedAt),
        }),
      ]);
    }).pipe(
      Effect.provide(
        runtime(engine, holdings, {
          runs: [
            run("a", { currentStep: Option.some("await-closed:approved") }),
            run("other", { itemKey: "pr-2" }),
          ],
          waits: [wait("a", "one"), wait("a", "two"), wait("other", "three")],
        }),
      ),
    ),
  );

  const unknown = fakeEngine();

  effect("an unknown, ambiguous or finished run fails and changes nothing", () =>
    Effect.gen(function* () {
      const failures = [];

      for (const asked of ["nope", "ab", "done-1", "done"]) {
        failures.push(
          (yield* Effect.flip(cancelRunHandler({ target: byId(asked), ...asAlice })))._tag,
        );
      }

      expect(failures).toEqual([
        "RunNotNamed",
        "AmbiguousRunPrefix",
        "RunAlreadyFinished",
        "RunAlreadyFinished",
      ]);
      expect([unknown.interrupted, unknown.notes]).toEqual([[], []]);
      expect(yield* statusOf("done-1")).toEqual(Option.some("done"));
    }).pipe(
      Effect.provide(
        runtime(unknown, fakeHoldings(), {
          runs: [run("abc"), run("abd"), finished],
        }),
      ),
    ),
  );

  const prefixed = stoppingEngine("abc");

  effect("a prefix names the run in flight before finished ones", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("ab"), ...asAlice });

      expect(cancelled.run.id).toBe(RunId.make("abc"));
    }).pipe(
      Effect.provide(
        runtime(prefixed, fakeHoldings(), {
          runs: [run("abc"), run("abd", { ...finished, id: RunId.make("abd") })],
        }),
      ),
    ),
  );

  const byItem = stoppingEngine("mine");

  effect("names a run by its repo's item, narrowed by flow and persona", () =>
    Effect.gen(function* () {
      const target = CancelTarget.cases.ByItem.make({
        repo: "demo",
        itemKey: "pr-1",
        flow: Option.none(),
        persona: Option.none(),
      });

      const several = yield* Effect.flip(cancelRunHandler({ target, ...asAlice }));

      const missing = yield* Effect.flip(
        cancelRunHandler({ target: { ...target, itemKey: "pr-9" }, ...asAlice }),
      );

      const cancelled = yield* cancelRunHandler({
        target: { ...target, persona: Option.some("alice") },
        ...asAlice,
      });

      expect([several._tag, missing._tag]).toEqual(["SeveralRunsInFlight", "NoRunInFlight"]);
      expect(cancelled.run.id).toBe(RunId.make("mine"));
    }).pipe(
      Effect.provide(
        runtime(byItem, fakeHoldings(), {
          runs: [run("theirs"), run("mine", { persona: Option.some("alice") })],
        }),
      ),
    ),
  );

  const issueEngine = stoppingEngine("i");

  const issueHoldings = fakeHoldings({
    worktrees: {
      i: {
        removed: ["/w/auto-issue-7"],
        kept: [{ path: "/w/auto-issue-7@bob", reason: "it has uncommitted changes" }],
      },
    },
    claims: { i: { branch: "auto/issue-7", kept: Option.none() } },
    sessions: { i: [{ sessionId: "s", launcher: "orca", handle: "term-1" }] },
  });

  effect("releases an issue's claim and removes worktrees, leaving sessions open", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("i"), ...asAlice });

      expect(issueHoldings.released).toEqual([7]);
      expect(cancelled.removedWorktrees).toEqual(["/w/auto-issue-7"]);
      expect(cancelled.released).toEqual(
        Option.some({ issue: 7, deletedBranch: Option.some("auto/issue-7") }),
      );
      expect(cancelled.leftForPerson).toEqual([
        "kept worktree /w/auto-issue-7@bob: it has uncommitted changes",
      ]);
      expect([cancelled.openSessions.length, issueHoldings.closed]).toEqual([1, []]);
    }).pipe(
      Effect.provide(
        runtime(issueEngine, issueHoldings, {
          runs: [run("i", { flow: "implement", itemKey: "issue-7" })],
        }),
      ),
    ),
  );

  const stale = stoppingEngine("old");

  const staleHoldings = fakeHoldings({
    claims: { old: { branch: "auto/issue-9", kept: Option.none() } },
  });

  effect(
    "ends a run this binary can't resume as needing a person, cleaning up as a cancel does",
    () =>
      Effect.gen(function* () {
        const ended = yield* cancelRunHandler({
          target: byId("old"),
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some<EndAs>({
            ending: "needs-human",
            reason: "it started under @chernabog/sdk 0.5.0",
          }),
        });

        expect([ended.run.status, ended.run.summary]).toEqual([
          "needs-human",
          Option.some("it started under @chernabog/sdk 0.5.0"),
        ]);
        expect(stale.interrupted).toEqual(["execution-old"]);
        expect(staleHoldings.released).toEqual([9]);
      }).pipe(
        Effect.provide(
          runtime(stale, staleHoldings, {
            runs: [run("old", { flow: "implement", itemKey: "issue-9", coreVersion: "0.5.0" })],
          }),
        ),
      ),
  );

  const gone = stoppingEngine("g");

  const goneHoldings = fakeHoldings({
    claimRefs: { g: ["issue-7"] },
    claims: { g: { branch: "auto/issue-7", kept: Option.some("it has 1 commit not on main") } },
    sessions: { g: [{ sessionId: "s", launcher: "orca", handle: "term-1" }] },
  });

  effect(
    "ends a run whose item went as superseded, with why, releasing it as a cancel does and leaving its session open",
    () =>
      Effect.gen(function* () {
        const ended = yield* cancelRunHandler({
          target: byId("g"),
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some<EndAs>({ ending: "superseded", reason: "#7 was closed" }),
        });

        expect([ended.run.status, ended.run.summary]).toEqual([
          "superseded",
          Option.some("#7 was closed; interrupted in implement"),
        ]);
        expect(gone.interrupted).toEqual(["execution-g"]);
        expect(gone.notes).toEqual(["g: superseded: #7 was closed; interrupted in implement"]);
        expect(ended.releasedClaims).toEqual(["refs/chernabog/claims/issue-7"]);
        expect(goneHoldings.released).toEqual([7]);
        expect([ended.openSessions.length, goneHoldings.closed]).toEqual([1, []]);
        expect(yield* statusOf("g")).toEqual(Option.some("superseded"));
      }).pipe(
        Effect.provide(
          runtime(gone, goneHoldings, {
            runs: [
              run("g", {
                flow: "implement",
                itemKey: "issue-7",
                currentStep: Option.some("implement"),
              }),
            ],
          }),
        ),
      ),
  );

  const closing = stoppingEngine("i");

  const closingHoldings = fakeHoldings({
    claims: {
      i: { branch: "auto/issue-7", kept: Option.some("it has 2 commits not on main") },
    },
    sessions: { i: [{ sessionId: "s", launcher: "orca", handle: "term-1" }] },
  });

  effect("closes sessions only when asked, and keeps a branch with work on it", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({
        target: byId("i"),
        by: "alice",
        closeSessions: true,
        endAs: Option.none(),
      });

      expect(closingHoldings.closed).toEqual(["term-1"]);
      expect(cancelled.closedSessions.length).toBe(1);
      expect(cancelled.released).toEqual(Option.some({ issue: 7, deletedBranch: Option.none() }));
      expect(cancelled.leftForPerson).toEqual([
        "kept branch auto/issue-7: it has 2 commits not on main",
      ]);
    }).pipe(
      Effect.provide(
        runtime(closing, closingHoldings, {
          runs: [run("i", { flow: "implement", itemKey: "issue-7" })],
        }),
      ),
    ),
  );

  const failing = stoppingEngine("i");

  effect("cleanup that fails is left for a person, and the run stays cancelled", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("i"), ...asAlice });

      expect(cancelled.run.status).toBe("cancelled");
      expect(cancelled.leftForPerson).toEqual([
        "removing its worktrees failed: gh is down",
        "deleting its claim ref on issue-7 failed: gh is down",
        "releasing its claim on #7 failed: gh is down",
      ]);
      expect(yield* statusOf("i")).toEqual(Option.some("cancelled"));
    }).pipe(
      Effect.provide(
        runtime(failing, fakeHoldings({ failing: { i: "gh is down" } }), {
          runs: [run("i", { flow: "implement", itemKey: "issue-7" })],
        }),
      ),
    ),
  );

  const holding = stoppingEngine("issue-run", "pr-run");

  const holdingRefs = fakeHoldings({
    claimRefs: { "issue-run": ["issue-7"], "pr-run": ["pr-1"] },
  });

  effect("deletes the claim ref a run holds, on an issue or a pull request", () =>
    Effect.gen(function* () {
      const onIssue = yield* cancelRunHandler({ target: byId("issue-run"), ...asAlice });
      const onPull = yield* cancelRunHandler({ target: byId("pr-run"), ...asAlice });

      expect([onIssue.releasedClaims, onPull.releasedClaims]).toEqual([
        ["refs/chernabog/claims/issue-7"],
        ["refs/chernabog/claims/pr-1"],
      ]);
      expect([onIssue.alreadyEnded, onPull.alreadyEnded]).toEqual([false, false]);
    }).pipe(
      Effect.provide(
        runtime(holding, holdingRefs, {
          runs: [
            run("issue-run", { flow: "implement", itemKey: "issue-7" }),
            run("pr-run", { itemKey: "pr-1-changes-2" }),
          ],
        }),
      ),
    ),
  );

  const leftBehind = fakeEngine();
  const leftRefs = fakeHoldings({ claimRefs: { "ended-1": ["issue-7"] } });

  effect(
    "a run that ended with its claim ref still held keeps its ending, and only lets the ref go",
    () =>
      Effect.gen(function* () {
        const released = yield* cancelRunHandler({ target: byId("ended-1"), ...asAlice });

        expect(released.alreadyEnded).toBe(true);
        expect(released.run.status).toBe("done");
        expect(released.releasedClaims).toEqual(["refs/chernabog/claims/issue-7"]);
        expect([leftRefs.cleaned, leftRefs.released]).toEqual([[], []]);
        expect([leftBehind.interrupted, leftBehind.notes]).toEqual([[], []]);
        expect(yield* statusOf("ended-1")).toEqual(Option.some("done"));

        // Once it is gone there is nothing left to let go of.
        const again = yield* Effect.flip(cancelRunHandler({ target: byId("ended-1"), ...asAlice }));
        expect(again._tag).toBe("RunAlreadyFinished");
      }).pipe(
        Effect.provide(
          runtime(leftBehind, leftRefs, {
            runs: [
              run("ended-1", {
                ...finished,
                id: RunId.make("ended-1"),
                flow: "implement",
                itemKey: "issue-7",
              }),
            ],
          }),
        ),
      ),
  );

  const shared = stoppingEngine("review");

  const sharedHoldings = fakeHoldings({
    worktrees: { review: { removed: ["/w/review-pr-1@bob"], kept: [] } },
  });

  effect("keeps the worktrees while another run in flight is on the same pull request", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("review"), ...asAlice });

      expect(cancelled.run.status).toBe("cancelled");
      expect(sharedHoldings.cleaned).toEqual([]);
      expect(cancelled.removedWorktrees).toEqual([]);
      expect(cancelled.leftForPerson).toEqual([
        "kept its worktrees: run re-review (demo/re-review pr-1-review-1 as bob) is in flight on the same item",
      ]);
    }).pipe(
      Effect.provide(
        runtime(shared, sharedHoldings, {
          runs: [run("review"), run("re-review", { flow: "re-review", itemKey: "pr-1-review-1" })],
        }),
      ),
    ),
  );

  const apart = stoppingEngine("review");
  const apartHoldings = fakeHoldings();

  effect("a run in flight on another pull request doesn't keep them", () =>
    Effect.gen(function* () {
      yield* cancelRunHandler({ target: byId("review"), ...asAlice });

      expect(apartHoldings.cleaned).toEqual(["review"]);
    }).pipe(
      Effect.provide(
        runtime(apart, apartHoldings, {
          runs: [run("review"), run("other", { itemKey: "pr-2" })],
        }),
      ),
    ),
  );

  const unloaded = fakeEngine();
  unloaded.unloaded.push("demo/review");

  effect("a flow this process didn't load is interrupted without waiting on it", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("a"), ...asAlice });

      expect([cancelled.stopped, unloaded.interrupted]).toEqual([false, ["execution-a"]]);
    }).pipe(Effect.provide(runtime(unloaded, fakeHoldings(), { runs: [run("a")] }))),
  );

  const unexecuted = fakeEngine();

  effect("a run with no execution yet is cancelled with nothing to interrupt", () =>
    Effect.gen(function* () {
      const cancelled = yield* cancelRunHandler({ target: byId("a"), ...asAlice });

      expect([cancelled.stopped, unexecuted.interrupted]).toEqual([true, []]);
    }).pipe(
      Effect.provide(
        runtime(unexecuted, fakeHoldings(), {
          runs: [run("a", { executionId: Option.none() })],
        }),
      ),
    ),
  );
});
