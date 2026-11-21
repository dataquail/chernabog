// A merge held for a red base branch in a CI job (audit W3, ADR 0021 decision
// 4): the job ends at the park and its journal goes with it, so the hold
// lives in the pull request's merge-held record, which names the work item
// that holds it. Once the base is green again, or the hold has lasted past
// mergeHoldTimeout, the recipe whose run held it offers the pull request as
// work a run may start, and a new run merges it, or hands it to a person.

import { type CiState, PullRequest } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import reReviewFlow from "../packages/recipes/flows/re-review.ts";
import reviewFlow from "../packages/recipes/flows/review.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { type Fake, flowTriggered, HEAD, makeFake, PULL, repo, runToEnd } from "./sdk-fakes.ts";

const SHIP = "auto:ship";
const KEY = `pr-${PULL}`;
const PR_ITEM = `pr-${PULL}`;
const RED: CiState = { state: "red", failedChecks: ["test"] };
const GREEN: CiState = { state: "green" };
const HOLDING = { holdMergesOnBrokenBase: true, mergeHoldTimeout: "1 day" };

// The review recipe in a repo whose config.yaml holds merges on a red base.
const reviewing = flowHandle(
  { ...repo, personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared: HOLDING })) },
  "review",
  reviewFlow,
);

// What a CI job that approved the pull request, held its merge for a red
// base and ended leaves behind: the approval, and the pull request's record
// naming the work item that holds it, written `at`. No hold comment: the
// record is what counts.
const heldEarlier = (base: CiState, at: DateTime.Utc, key = KEY) => {
  const fake = makeFake("approve", { ciJob: true });
  fake.recordReview({ sha: HEAD, round: 1, verdict: "approve" });
  fake.setLabels(PULL, [SHIP]);
  fake.merge.baseCi = Option.some(base);
  fake.recordPhase(PR_ITEM, "merge-held", { at, data: { key } });

  return fake;
};

const offeredBy = (fake: Fake, flow: typeof reviewFlow) =>
  flowTriggered(fake, flow, HOLDING).pipe(
    Effect.map((items) => items.filter((found) => Option.isSome(PullRequest.resumingMerge(found)))),
    Effect.orDie,
  );

const onlyOffered = (fake: Fake) =>
  Effect.flatMap(offeredBy(fake, reviewFlow), (items) => Effect.fromOption(Arr.head(items))).pipe(
    Effect.orDie,
  );

describe("a merge held in a CI job", () => {
  effect("once the base is green, is work the holding recipe's run may start, and only its", () =>
    Effect.gen(function* () {
      const fake = heldEarlier(GREEN, yield* DateTime.now);

      const offered = yield* onlyOffered(fake);
      expect([offered.key, offered.signals, mayStart(offered)]).toEqual([
        KEY,
        [PullRequest.BASE_GREEN],
        true,
      ]);

      // re-review's runs are keyed pr-N-<more>; this hold is review's.
      expect(yield* offeredBy(fake, reReviewFlow)).toEqual([]);
    }),
  );

  effect("while the base is still red and the hold has time left, is not offered", () =>
    Effect.gen(function* () {
      const fake = heldEarlier(RED, yield* DateTime.now);

      expect(yield* offeredBy(fake, reviewFlow)).toEqual([]);
    }),
  );

  effect("a new run merges it, without reviewing again", () =>
    Effect.gen(function* () {
      const fake = heldEarlier(GREEN, yield* DateTime.now);

      const finished = yield* runToEnd(reviewing, fake, yield* onlyOffered(fake));

      expect(finished.status).toBe("done");
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
      expect(fake.requests).toEqual([]);
    }),
  );

  effect("held past mergeHoldTimeout, a new run hands it to a person without merging", () =>
    Effect.gen(function* () {
      const fake = heldEarlier(RED, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));

      const due = yield* onlyOffered(fake);
      expect(Option.fromUndefinedOr(due.signals)).toEqual(Option.none());

      const ended = yield* runToEnd(reviewing, fake, due);

      expect(ended.status).toBe("needs-human");

      expect(fake.merge.requests).toEqual([]);
      expect(fake.requests).toEqual([]);
      expect(
        fake.comments.some((comment) => comment.body.includes("CI on main stayed red for 1d")),
      ).toBe(true);

      // Handed to a person, it is not offered again, red base or green.
      expect(yield* offeredBy(fake, reviewFlow)).toEqual([]);

      fake.merge.baseCi = Option.some(GREEN);
      expect(yield* offeredBy(fake, reviewFlow)).toEqual([]);
      expect(fake.merge.requests).toEqual([]);
    }),
  );
});
