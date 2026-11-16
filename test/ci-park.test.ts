// Implement.waitForCi in a CI job (#513): with somewhere to park, a first
// reading of the pull request's checks that is still pending records the
// round it waits on and parks the run, so `ci run` ends the job rather than
// billing the wait. A daemon's run, or one with nowhere to park, polls.

import { defineFlow, Implement, NeedsHuman, Phases } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  item,
  makeFake,
  onFake,
  PULL,
  repo,
  runToEnd,
  runUntil,
  summaryOf,
} from "./sdk-fakes.ts";

const PR_ITEM = Phases.pullRequestItem(PULL);
const BRANCH = "auto/issue-3";

// A flow that only waits for the pull request's CI, as `options` say: it
// parks on the pull request's record when they name it.
const waiting = (options: Implement.CiWait) =>
  flowHandle(
    repo,
    "wait",
    defineFlow({
      trigger: Effect.succeed([]),
      workflow: () =>
        Implement.waitForCi(
          PULL,
          "/tmp/demo-worktrees/auto/issue-3",
          { ...Implement.thisRunsSession, branch: BRANCH },
          options,
        ).pipe(
          Effect.as("green"),
          Effect.catchTags({
            CiTimedOut: (timedOut) => Effect.fail(new NeedsHuman({ reason: timedOut.message })),
            NothingCommitted: (nothing) =>
              Effect.fail(new NeedsHuman({ reason: `nothing committed on ${nothing.branch}` })),
            PushRejected: (rejected) => Effect.fail(new NeedsHuman({ reason: rejected.message })),
          }),
        ),
    }),
  );

const PARKING: Implement.CiWait = { park: PR_ITEM };

// Whether the run waits on CI_SETTLED for this round.
const parkedOn = (run: EngineRun, round: number) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal: Implement.CI_SETTLED }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${Implement.CI_SETTLED}:ci-${round}`),
  );

// Lets the run go 20 polls of the engine, then says whether it parked by then.
const parkedAfterPolls = (handle: ReturnType<typeof waiting>, fake: ReturnType<typeof makeFake>) =>
  Effect.gen(function* () {
    let polls = 0;
    let parked = false;

    const run = yield* runUntil(handle, fake, item("pr"), (polled) =>
      Effect.gen(function* () {
        polls += 1;
        parked = yield* parkedOn(polled, 1);

        return parked || polls >= 20;
      }),
    );

    return { run, parked };
  });

describe("the phase a parked wait records", () => {
  test("names the round of CI, the first plainly", () => {
    expect(Phases.awaitingCi(1)).toBe("awaiting-ci");
    expect(Phases.awaitingCi(3)).toBe("awaiting-ci-3");
  });

  test("gives its round back, and none for any other phase", () => {
    expect(Phases.ciRoundOf("awaiting-ci")).toEqual(Option.some(1));
    expect(Phases.ciRoundOf("awaiting-ci-3")).toEqual(Option.some(3));
    expect(Phases.ciRoundOf("review-asked")).toEqual(Option.none());
    expect(Phases.ciRoundOf("awaiting-ci-x")).toEqual(Option.none());
  });
});

describe("a wait for CI in a CI job", () => {
  effect("parks on pending CI, having recorded the round it waits on", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };

      const run = yield* runUntil(waiting(PARKING), fake, item("pr"), (polled) =>
        parkedOn(polled, 1),
      );

      expect(run.status).toBe("running");
      expect(fake.phases()[PR_ITEM]).toBe("awaiting-ci");
    }),
  );

  effect("goes on without parking when CI is already green", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      const finished = yield* runToEnd(waiting(PARKING), fake, item("pr"));
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe("green");
      expect(fake.phases()[PR_ITEM]).toBeUndefined();
    }),
  );

  effect("parks on the round after a fix: the fix is pushed, then the next round recorded", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      // The fix's push starts CI again, which is still running when the run reads it.
      fake.merge.afterPush = Option.some({ state: "pending", waitingOn: ["test"] });

      const run = yield* runUntil(
        waiting({ ...PARKING, firstRound: 2 }),
        fake,
        item("pr"),
        (polled) => parkedOn(polled, 3),
      );

      expect(summaryOf(run)).toBe("");
      expect(run.status).toBe("running");
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.prompt).toContain(`CI failed on pull request #${PULL}: test.`);
      expect(fake.phases()[PR_ITEM]).toBe("awaiting-ci-3");
    }),
  );

  effect("resumed past ciRounds, hands red CI to a person without another fix", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      fake.merge.ci = { state: "red", failedChecks: ["test"] };
      const finished = yield* runToEnd(waiting({ ...PARKING, firstRound: 4 }), fake, item("pr"));
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("CI is still red after 3 fix attempts");
      expect(fake.requests).toEqual([]);
    }),
  );

  effect("with nowhere to park, polls as a daemon's run does", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };
      const { parked, run } = yield* parkedAfterPolls(waiting({}), fake);
      expect(run.status).toBe("running");
      expect(parked).toBe(false);
      expect(fake.phases()[PR_ITEM]).toBeUndefined();
    }),
  );
});

describe("a wait for CI on a daemon", () => {
  effect("polls, even with somewhere to park", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };
      const { parked, run } = yield* parkedAfterPolls(waiting(PARKING), fake);
      expect(run.status).toBe("running");
      expect(parked).toBe(false);
      expect(fake.phases()[PR_ITEM]).toBeUndefined();
    }),
  );
});

describe("waitingOnCi", () => {
  effect("holds an item while its pull request's CI is pending, and not once it settles", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };

      expect(yield* onFake(fake, Implement.waitingOnCi(PULL))).toEqual(
        Option.some(`waits on CI for #${PULL}`),
      );

      fake.merge.ci = { state: "red", failedChecks: ["test"] };
      expect(yield* onFake(fake, Implement.waitingOnCi(PULL))).toEqual(Option.none());
      fake.merge.ci = { state: "green" };
      expect(yield* onFake(fake, Implement.waitingOnCi(PULL))).toEqual(Option.none());
    }),
  );
});
