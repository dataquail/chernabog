// Implement.waitForCi in a CI job (#513): with somewhere to park, a first
// reading of the pull request's checks that is still pending records the
// round it waits on and parks the run, so `ci run` ends the job rather than
// billing the wait. A daemon's run parks the same way (ADR 0021); one with
// nowhere to park polls.

import {
  DEFAULT_LABELS,
  defineFlow,
  Implement,
  NeedsHuman,
  Phases,
  Review,
  reviewMarker,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import addressReview from "../packages/recipes/flows/address-review.ts";
import implement from "../packages/recipes/flows/implement.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  HEAD,
  ISSUE,
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

const PARKING: Implement.CiWait = Review.parkOnPullRequest(PULL);

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

  effect("with nowhere to park, polls", () =>
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
  // ADR 0021, decision 4: a daemon's run parks as a CI job's does, and the
  // daemon ends it there; the record carries the wait.
  effect("parks on pending CI, as a CI job's run does, having recorded the round", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };
      const { parked, run } = yield* parkedAfterPolls(waiting(PARKING), fake);
      expect(run.status).toBe("running");
      expect(parked).toBe(true);
      expect(fake.phases()[PR_ITEM]).toBe("awaiting-ci");
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

// The implement recipe in a CI job: it ends the job on pending CI, and a
// later job resumes the issue from its record once CI has finished.
describe("implement in a CI job", () => {
  const implementing = flowHandle(repo, "implement", implement);
  const ISSUE_ITEM = Phases.issueItem(ISSUE);
  const POOL = { reviewers: ["zach", "data-quail"] };
  const PULL_URL = `https://github.com/dataquail/demo/pull/${PULL}`;

  // A queued issue, implemented in a CI job.
  const queuedInCi = () => {
    const fake = makeFake("approve", { ...POOL, ciJob: true });
    fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

    return fake;
  };

  // The issue's pull request open, and its record saying a CI job parked on round `round`.
  const parkedInCi = (round: number) => {
    const fake = makeFake("approve", { ...POOL, ciJob: true });
    fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
    fake.git.opened = true;
    fake.recordPhase(ISSUE_ITEM, Phases.awaitingCi(round));

    return fake;
  };

  const resumes = (fake: Fake) =>
    flowTriggered(fake, implement).pipe(
      Effect.map((items) => items.filter((found) => Option.isSome(Implement.resumingCi(found)))),
      Effect.orDie,
    );

  // The one item the trigger offers to resume.
  const onlyResume = (fake: Fake) =>
    Effect.flatMap(resumes(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

  effect(
    "ends the job on pending CI, having opened the pull request and recorded the wait on the issue",
    () =>
      Effect.gen(function* () {
        const fake = queuedInCi();
        fake.merge.ci = { state: "pending", waitingOn: ["test"] };

        const run = yield* runUntil(
          implementing,
          fake,
          item(`issue-${ISSUE}`, { issue: ISSUE }),
          (polled) => parkedOn(polled, 1),
        );

        expect(run.status).toBe("running");
        expect(fake.git.opened).toBe(true);
        expect(fake.phases()[ISSUE_ITEM]).toBe("awaiting-ci");
        // Not handed off: nobody is asked to review it yet.
        expect(fake.people.requested).toEqual([]);
        expect(fake.phases()[PR_ITEM]).toBeUndefined();
      }),
  );

  effect("holds the parked issue while CI runs, and offers it to resume once CI finishes", () =>
    Effect.gen(function* () {
      const fake = parkedInCi(2);
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };

      const held = yield* resumes(fake);
      expect(held.map((found) => [found.key, found.held])).toEqual([
        [`issue-${ISSUE}`, `waits on CI for #${PULL}`],
      ]);

      fake.merge.ci = { state: "green" };
      const ready = yield* resumes(fake);
      expect(
        ready.map((found) => [found.key, Option.fromUndefinedOr(found.held), found.data]),
      ).toEqual([
        [
          `issue-${ISSUE}`,
          Option.none(),
          { issue: ISSUE, resumeCi: { pullRequest: PULL, url: PULL_URL, round: 2 } },
        ],
      ]);
    }),
  );

  effect("offers nothing to resume for an issue a person has, or with no pull request open", () =>
    Effect.gen(function* () {
      const handed = parkedInCi(1);
      handed.setLabels(ISSUE, [DEFAULT_LABELS.needsHuman]);
      expect(yield* resumes(handed)).toEqual([]);

      const unopened = parkedInCi(1);
      unopened.git.opened = false;
      expect(yield* resumes(unopened)).toEqual([]);

      const elsewhere = parkedInCi(1);
      elsewhere.recordPhase(ISSUE_ITEM, "handed-off");
      expect(yield* resumes(elsewhere)).toEqual([]);
    }),
  );

  effect("resumed once CI is green, hands the pull request off without implementing again", () =>
    Effect.gen(function* () {
      const fake = parkedInCi(1);
      const finished = yield* runToEnd(implementing, fake, yield* onlyResume(fake));

      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(`#${ISSUE}: ${PULL_URL} is ready for review`);
      expect(fake.requests).toEqual([]);
      expect(fake.git.pushes).toBe(0);
      // One reviewer from the pool is asked.
      expect(fake.people.requested).toHaveLength(1);
      expect(POOL.reviewers).toContain(fake.people.requested[0] ?? "");
      expect(fake.phases()[ISSUE_ITEM]).toBe("handed-off");
      expect(fake.phases()[PR_ITEM]).toBe("review-asked");
      // The issue says where the pull request is, and that CI passed after the job that opened it.
      expect(
        fake.comments.some(
          (comment) =>
            comment.body.startsWith(`Pull request ready for review: ${PULL_URL}`) &&
            comment.body.includes("CI passed after the job that opened it ended"),
        ),
      ).toBe(true);
    }),
  );

  effect(
    "resumed on red CI, fixes it in a worktree on the issue's branch, from the recorded round",
    () =>
      Effect.gen(function* () {
        const fake = parkedInCi(2);
        fake.merge.ci = { state: "red", failedChecks: ["test"] };
        fake.merge.afterPush = Option.some({ state: "green" });
        const finished = yield* runToEnd(implementing, fake, yield* onlyResume(fake));

        expect(finished.status).toBe("done");
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]?.cwd).toBe(`/tmp/demo-worktrees/auto/issue-${ISSUE}`);
        expect(fake.requests[0]?.prompt).toContain(`CI failed on pull request #${PULL}: test.`);
        expect(fake.git.pushes).toBe(1);
        expect(fake.phases()[ISSUE_ITEM]).toBe("handed-off");
      }),
  );

  effect("resumed on red CI past ciRounds, goes to a person", () =>
    Effect.gen(function* () {
      const fake = parkedInCi(4);
      fake.merge.ci = { state: "red", failedChecks: ["test"] };
      const finished = yield* runToEnd(implementing, fake, yield* onlyResume(fake));

      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("CI is still red after 3 fix attempts");
      expect(fake.requests).toEqual([]);
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );
});

// The address-review recipe in a CI job: it ends the job on its pushed fix's
// pending CI, and a later job asks the reviewer again once CI has finished.
describe("address-review in a CI job", () => {
  const addressing = flowHandle(repo, "address-review", addressReview);

  // A pull request this persona wrote, whose latest review, by data-quail,
  // asks for changes on HEAD, in a CI job.
  const changesAsked = () => {
    const fake = makeFake("approve", { ciJob: true });
    fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
    fake.comment(
      reviewMarker.write({
        sha: HEAD,
        round: 1,
        verdict: "request-changes",
        reviewer: "data-quail",
        sessionId: "review-session",
        adapter: "codex",
      }),
    );
    fake.comment(
      'Implemented by claude for #3. <!-- chernabog-session {"adapter":"claude","sessionId":"implement-session","issue":3,"branch":"auto/issue-3"} -->',
    );
    // The implement run's push.
    fake.git.pushes = 1;

    return fake;
  };

  // The fix pushed over HEAD, and the record saying a CI job parked on round `round`.
  const fixParked = (round: number) => {
    const fake = changesAsked();
    fake.git.pushes = 2;
    fake.git.head = "fix20000000";
    fake.recordPhase(PR_ITEM, Phases.awaitingCi(round));

    return fake;
  };

  const resumes = (fake: Fake) =>
    flowTriggered(fake, addressReview).pipe(
      Effect.map((items) =>
        items.filter((found) =>
          Option.exists(Schema.decodeUnknownOption(Review.AddressItem)(found.data), (address) =>
            Option.isSome(Review.resumingCi(address)),
          ),
        ),
      ),
      Effect.orDie,
    );

  const onlyResume = (fake: Fake) =>
    Effect.flatMap(resumes(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

  effect(
    "pushes the fix and ends the job on its pending CI, recording the wait on the pull request",
    () =>
      Effect.gen(function* () {
        const fake = changesAsked();
        fake.merge.afterPush = Option.some({ state: "pending", waitingOn: ["test"] });

        const run = yield* runUntil(
          addressing,
          fake,
          item(`pr-${PULL}-changes-1`, {
            pullRequest: PULL,
            headRef: "auto/issue-3",
            agentWritten: true,
            reviewer: "data-quail",
            reviewedSha: HEAD,
          }),
          (polled) =>
            Effect.map(
              listRunWaitsHandler({ runId: polled.id, signal: Implement.CI_SETTLED }),
              ({ waits }) => waits.length > 0,
            ),
        );

        expect(run.status).toBe("running");
        expect(fake.git.pushes).toBe(2);
        expect(fake.phases()[PR_ITEM]).toBe("awaiting-ci");
        // The reviewer isn't asked again until CI has finished.
        expect(fake.people.requested).toEqual([]);
      }),
  );

  effect("holds the parked fix while CI runs, and offers it to resume once CI finishes", () =>
    Effect.gen(function* () {
      const fake = fixParked(2);
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };

      const held = yield* resumes(fake);
      expect(
        held.map((found) => [found.key.startsWith(`pr-${PULL}-awaiting-ci-2-`), found.held]),
      ).toEqual([[true, `waits on CI for #${PULL}`]]);

      fake.merge.ci = { state: "green" };
      const ready = yield* resumes(fake);
      expect(ready.map((found) => [Option.fromUndefinedOr(found.held), found.data])).toEqual([
        [
          Option.none(),
          {
            pullRequest: PULL,
            headRef: "auto/issue-3",
            baseRef: "main",
            agentWritten: true,
            reviewer: "data-quail",
            reviewedSha: HEAD,
            resumeCi: { round: 2 },
          },
        ],
      ]);
      // Only once: changes asked on a head that has moved is not another item to address.
      expect(yield* flowTriggered(fake, addressReview).pipe(Effect.orDie)).toHaveLength(1);

      // With a person by its record (ADR 21, decision 1), the label its projection.
      fake.recordPhase(`pr-${PULL}`, "with-person");
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      expect(yield* resumes(fake)).toEqual([]);
    }),
  );

  effect(
    "a review asking for changes on the fix's head while its CI pends is new work, not the parked one",
    () =>
      Effect.gen(function* () {
        const fake = fixParked(1);
        fake.merge.ci = { state: "pending", waitingOn: ["test"] };
        fake.submitted.push({
          author: "data-quail",
          state: "CHANGES_REQUESTED",
          commitSha: "fix20000000",
        });

        // Not resumed as already addressed: nothing was pushed since this review.
        expect(yield* resumes(fake)).toEqual([]);

        // changesToAddress takes it up, as after a hand-off, and the record moves to changes-asked.
        const items = yield* flowTriggered(fake, addressReview).pipe(Effect.orDie);
        expect(
          items.map((found) => [found.key.startsWith(`pr-${PULL}-changes-asked-`), found.data]),
        ).toEqual([
          [
            true,
            {
              pullRequest: PULL,
              headRef: "auto/issue-3",
              baseRef: "main",
              agentWritten: true,
              reviewer: "data-quail",
              reviewedSha: "fix20000000",
            },
          ],
        ]);
        expect(fake.phases()[PR_ITEM]).toBe("changes-asked");
      }),
  );

  effect("an approval of the fix's head while its CI pends moves the record to approved", () =>
    Effect.gen(function* () {
      const fake = fixParked(1);
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };
      fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: "fix20000000" });

      expect(yield* flowTriggered(fake, addressReview).pipe(Effect.orDie)).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe("approved");
    }),
  );

  effect("resumed once CI is green, asks the reviewer again without another fix", () =>
    Effect.gen(function* () {
      const fake = fixParked(1);
      const finished = yield* runToEnd(addressing, fake, yield* onlyResume(fake));

      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(
        `#${PULL}: addressed review 1; asked data-quail to review again`,
      );
      expect(fake.requests).toEqual([]);
      expect(fake.git.pushes).toBe(2);
      expect(fake.people.requested).toEqual(["data-quail"]);
      expect(fake.phases()[PR_ITEM]).toBe("review-asked-again");
      expect(
        fake.comments.some((comment) =>
          comment.body.startsWith("Addressed review 1: the commits pushed since that review."),
        ),
      ).toBe(true);
    }),
  );

  effect("resumed on red CI, fixes it in the author's session from the recorded round", () =>
    Effect.gen(function* () {
      const fake = fixParked(2);
      fake.merge.ci = { state: "red", failedChecks: ["test"] };
      fake.merge.afterPush = Option.some({ state: "green" });
      const finished = yield* runToEnd(addressing, fake, yield* onlyResume(fake));

      expect(finished.status).toBe("done");
      expect(fake.requests.map((request) => request.sessionId)).toEqual(["implement-session"]);
      expect(fake.requests[0]?.prompt).toContain(`CI failed on pull request #${PULL}: test.`);
      expect(fake.git.pushes).toBe(3);
      expect(fake.people.requested).toEqual(["data-quail"]);
    }),
  );
});
