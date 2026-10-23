// The review and re-review flows end to end through the engine, on an
// in-memory GitHub: who they pick up, the reviews they post, and where each
// ending leaves the pull request.

import { DEFAULT_LABELS, type Flow, reviewMarker } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import addressReview from "../templates/recipes/flows/address-review.ts";
import reReview from "../templates/recipes/flows/re-review.ts";
import review from "../templates/recipes/flows/review.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  flowTriggered,
  HEAD,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  summaryOf,
  type Verdict,
} from "./sdk-fakes.ts";

const reviewing = flowHandle(repo, "review", review);
const reReviewing = flowHandle(repo, "re-review", reReview);
const addressing = flowHandle(repo, "address-review", addressReview);
const work = item(`pr-${PULL}`, { pullRequest: PULL, headRef: "auto/issue-3", agentWritten: true });

// A pull request that asks data-quail, the persona these runs act as, for a
// review; its reviews answer `verdicts` in turn.
const asked = (verdicts: ReadonlyArray<Verdict>, labels: ReadonlyArray<string> = []) => {
  const fake = makeFake(verdicts);
  fake.people.me = "data-quail";
  fake.people.requested = ["data-quail"];
  fake.setLabels(PULL, [...labels]);

  return fake;
};

const askAgain = (fake: Fake) => {
  fake.people.requested = ["data-quail"];
};

const keys = (fake: Fake, flow: Flow) =>
  Effect.map(flowTriggered(fake, flow), (items) => items.map((found) => found.key));

describe("review", () => {
  effect(
    "picks up a pull request whose review is requested of this persona, until it has reviewed it",
    () =>
      Effect.gen(function* () {
        const fake = asked(["approve"]);
        expect(yield* keys(fake, review)).toEqual([`pr-${PULL}`]);
        expect(yield* keys(fake, reReview)).toEqual([]);

        fake.people.me = "zach";
        expect(yield* keys(fake, review)).toEqual([]);
      }),
  );

  effect(
    "posts a real approval, and leaves a pull request off the automated path for a person to merge",
    () =>
      Effect.gen(function* () {
        const fake = asked(["approve"]);
        const finished = yield* runToEnd(reviewing, fake, work);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(`#${PULL} approved; a person merges`);
        expect(fake.submitted).toEqual([
          { author: "data-quail", state: "APPROVED", commitSha: HEAD },
        ]);
        expect(fake.merge.requests).toEqual([]);
        expect(fake.people.requested).toEqual([]);
      }),
  );

  effect("merges an approved auto:ship pull request, when that is safe", () =>
    Effect.gen(function* () {
      const fake = asked(["approve"], [DEFAULT_LABELS.ship]);
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  effect("hands an approved auto:ship pull request it may not merge to a person", () =>
    Effect.gen(function* () {
      const fake = asked(["approve"], [DEFAULT_LABELS.ship]);
      fake.merge.ci = { state: "red", failedChecks: ["test"] };
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("not merged: checks failed: test");
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect("requests changes as a real review, for the author to answer", () =>
    Effect.gen(function* () {
      const fake = asked(["request-changes"]);
      const finished = yield* runToEnd(reviewing, fake, work);
      expect(summaryOf(finished)).toBe(`#${PULL}: review 1 requested changes`);
      expect(fake.submitted.map((submitted) => submitted.state)).toEqual(["CHANGES_REQUESTED"]);
      // No label: the author's address-review reads the review itself.
      expect(fake.labelsOf(PULL)).toEqual([]);
    }),
  );
});

describe("re-review", () => {
  // Reviewed once with changes requested, then asked again after a push.
  const reviewedOnce = (verdicts: ReadonlyArray<Verdict>, labels: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const fake = asked(["request-changes", ...verdicts], labels);
      yield* runToEnd(reviewing, fake, work);
      fake.git.head = "fix20000000";
      askAgain(fake);

      return fake;
    });

  effect(
    "picks up a pull request this persona reviewed and is asked about again, unless a person has it",
    () =>
      Effect.gen(function* () {
        const fake = yield* reviewedOnce(["approve"]);
        expect(yield* keys(fake, reReview)).toEqual([`pr-${PULL}-review-2`]);
        expect(yield* keys(fake, review)).toEqual([]);

        fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
        expect(yield* keys(fake, reReview)).toEqual([]);
      }),
  );

  effect(
    "resumes its own review session, and an approval of an auto:ship pull request merges it",
    () =>
      Effect.gen(function* () {
        const fake = yield* reviewedOnce(["approve"], [DEFAULT_LABELS.ship]);

        const finished = yield* runToEnd(
          reReviewing,
          fake,
          item(`pr-${PULL}-review-2`, {
            pullRequest: PULL,
            headRef: "auto/issue-3",
            agentWritten: true,
          }),
        );

        expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);

        const [first, again] = fake.requests;
        expect(again.sessionId).toBe(first.sessionId);
        expect(Option.isSome(again.resumePrompt)).toBe(true);
        expect(fake.submitted.map((submitted) => submitted.state)).toEqual([
          "CHANGES_REQUESTED",
          "APPROVED",
        ]);
        expect(fake.merge.requests).toEqual([{ method: "squash", sha: "fix20000000" }]);
        expect(
          fake.comments.some((comment) =>
            comment.body.includes("Review 1's findings, re-reviewed."),
          ),
        ).toBe(true);
      }),
  );

  effect("requests changes again and hands the pull request to a person", () =>
    Effect.gen(function* () {
      const fake = yield* reviewedOnce(["request-changes"], [DEFAULT_LABELS.ship]);

      const finished = yield* runToEnd(
        reReviewing,
        fake,
        item(`pr-${PULL}-review-2`, {
          pullRequest: PULL,
          headRef: "auto/issue-3",
          agentWritten: true,
        }),
      );

      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("review 2 still requests changes");
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect("stops past limits.reviewRounds, without another review", () =>
    Effect.gen(function* () {
      const fake = asked(["approve"]);
      fake.comment(
        reviewMarker.write({
          sha: HEAD,
          round: 2,
          verdict: "request-changes",
          reviewer: "data-quail",
          sessionId: "earlier-session",
          adapter: "claude",
        }),
      );

      const finished = yield* runToEnd(
        reReviewing,
        fake,
        item(`pr-${PULL}-review-3`, {
          pullRequest: PULL,
          headRef: "auto/issue-3",
          agentWritten: true,
        }),
      );

      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("after 1 re-review, and limits.reviewRounds is 1");
      expect(fake.requests).toEqual([]);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );
});

describe("address-review", () => {
  // A pull request this persona, the author, wrote, whose latest review, by data-quail, asks for changes on its head.
  const changesAsked = (consider: "address" | "decline" = "address") => {
    const fake = makeFake(["approve"]);
    fake.author.consider = consider;
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

    return fake;
  };

  const addressWork = item(`pr-${PULL}-changes-1`, {
    pullRequest: PULL,
    headRef: "auto/issue-3",
    agentWritten: true,
    reviewer: "data-quail",
    reviewedSha: HEAD,
  });

  effect(
    "picks up its own pull request with changes asked on the head, until it's pushed, approved or a person has it",
    () =>
      Effect.gen(function* () {
        const fake = changesAsked();
        expect(yield* keys(fake, addressReview)).toEqual([`pr-${PULL}-changes-1`]);

        fake.people.me = "zach";
        expect(yield* keys(fake, addressReview)).toEqual([]);
        fake.people.me = "chernabog-bot";

        fake.git.head = "fix20000000";
        expect(yield* keys(fake, addressReview)).toEqual([]);
        fake.git.head = HEAD;

        fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
        expect(yield* keys(fake, addressReview)).toEqual([]);
        fake.setLabels(PULL, []);

        fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: HEAD });
        expect(yield* keys(fake, addressReview)).toEqual([]);
      }),
  );

  effect(
    "agrees: fixes in the implementing session, pushes with green CI, and asks the reviewer again",
    () =>
      Effect.gen(function* () {
        const fake = changesAsked();
        fake.comment(
          'Implemented by claude for #3. <!-- chernabog-session {"adapter":"claude","sessionId":"implement-session","issue":3,"branch":"auto/issue-3"} -->',
        );
        // The fix moves the head; the fake's first push is the implement run's.
        fake.git.pushes = 1;
        const finished = yield* runToEnd(addressing, fake, addressWork);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(
          `#${PULL}: addressed review 1; asked data-quail to review again`,
        );
        expect(fake.requests.map((request) => request.sessionId)).toEqual([
          "implement-session",
          "implement-session",
        ]);
        expect(fake.requests[0]?.prompt).toContain("Review 1 of pull request #7 asks for changes");
        expect(fake.git.pushes).toBe(2);
        expect(fake.people.requested).toEqual(["data-quail"]);
        expect(fake.labelsOf(PULL)).not.toContain(DEFAULT_LABELS.needsHuman);
      }),
  );

  effect(
    "hands a fix that touches humanOnlyPaths to a person, on a pull request nobody worked on",
    () =>
      Effect.gen(function* () {
        const fake = changesAsked();
        fake.comment(
          'Implemented by claude for #3. <!-- chernabog-session {"adapter":"claude","sessionId":"implement-session","issue":3,"branch":"auto/issue-3"} -->',
        );
        fake.git.pushes = 1;
        fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];
        const finished = yield* runToEnd(addressing, fake, addressWork);
        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain(
          "the change touches paths a person must handle: `.github/workflows/ci.yml`",
        );
        expect(fake.git.pushes).toBe(1);
        expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
        expect(fake.people.requested).toEqual([]);
      }),
  );

  effect(
    "disagrees: replies with its reasons and hands the pull request to a person, without pushing or asking again",
    () =>
      Effect.gen(function* () {
        const fake = changesAsked("decline");
        const finished = yield* runToEnd(addressing, fake, addressWork);
        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain("the author disputes review 1");
        expect(
          fake.comments.some((comment) => comment.body.startsWith("Not addressing review 1:")),
        ).toBe(true);
        expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
        expect(fake.git.pushes).toBe(0);
        expect(fake.people.requested).toEqual([]);
      }),
  );
});
