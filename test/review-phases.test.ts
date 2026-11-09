// The review loop on phases (#365): the blocks that own a handoff record the
// pull request's phase, and review's, re-review's and address-review's
// sources read it rather than working progress out from review counts. A
// label, an assignee or a review count that changes leaves the record where
// it was; a closed or merged pull request ends it; a record GitHub disagrees
// with is held, for status to say why. A pull request from before phases,
// with no record, is still read as before.

import { DEFAULT_LABELS, type Flow, reviewMarker } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import implement from "../packages/recipes/flows/implement.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import review from "../packages/recipes/flows/review.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { documentOf, loadFlow, REVIEW_DOCUMENT } from "./compose-harness.ts";
import {
  IMPLEMENT_WORK_ITEM,
  observe,
  queued,
  REVIEW_WORK_ITEM,
  reviewAsked,
} from "./compose-scenarios.ts";
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
} from "./sdk-fakes.ts";

const reviewing = flowHandle(repo, "review", review);
const reReviewing = flowHandle(repo, "re-review", reReview);
const addressing = flowHandle(repo, "address-review", addressReview);

const ITEM = `pr-${PULL}`;
const FIX = "fix20000000";

const triggered = (fake: Fake, flow: Flow) => flowTriggered(fake, flow);

const keys = (fake: Fake, flow: Flow) =>
  Effect.map(triggered(fake, flow), (items) => items.map((found) => found.key));

const helds = (fake: Fake, flow: Flow) =>
  Effect.map(triggered(fake, flow), (items) => items.map((found) => found.held));

// The persona that reviews, and the one that wrote the pull request.
const asReviewer = (fake: Fake) => {
  fake.people.me = "data-quail";
};

const asAuthor = (fake: Fake) => {
  fake.people.me = "chernabog-bot";
};

// The implement run's session marker, and its push.
const implemented = (fake: Fake) => {
  fake.comment(
    'Implemented by claude for #3. <!-- chernabog-session {"adapter":"claude","sessionId":"implement-session","issue":3,"branch":"auto/issue-3"} -->',
  );
  fake.git.pushes = 1;
};

// Changes asked on the head by data-quail, with its review's marker, and
// the pull request's record at `phase`, or none.
const changesAskedOnHead = (phase: Option.Option<string> = Option.none()) => {
  const fake = makeFake(["approve"]);
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

  for (const recorded of Option.toArray(phase)) {
    fake.recordPhase(ITEM, recorded);
  }

  return fake;
};

const addressWork = (key: string) =>
  item(key, {
    pullRequest: PULL,
    headRef: "auto/issue-3",
    agentWritten: true,
    reviewer: "data-quail",
    reviewedSha: HEAD,
  });

const reviewWork = (key: string) =>
  item(key, { pullRequest: PULL, headRef: "auto/issue-3", agentWritten: true });

describe("the blocks that own a handoff record its phase", () => {
  effect("implement's hand-off: the pull request waits for review, the issue is handed off", () =>
    Effect.gen(function* () {
      const observed = yield* observe(implement, "implement", queued, IMPLEMENT_WORK_ITEM);
      expect(observed.status).toBe("done");
      expect(observed.phases).toEqual({ [ITEM]: "review-asked", "issue-3": "handed-off" });
    }),
  );

  effect("a review that asks for changes", () =>
    Effect.gen(function* () {
      const observed = yield* observe(
        review,
        "review",
        () => reviewAsked("request-changes"),
        REVIEW_WORK_ITEM,
      );

      expect(observed.phases).toEqual({ [ITEM]: "changes-asked" });
    }),
  );

  effect("a review that approves, whether a person merges or it does", () =>
    Effect.gen(function* () {
      for (const labels of [[], [DEFAULT_LABELS.ship]]) {
        const observed = yield* observe(
          review,
          "review",
          () => reviewAsked("approve", labels),
          REVIEW_WORK_ITEM,
        );

        expect(observed.phases).toEqual({ [ITEM]: "approved" });
      }
    }),
  );
});

describe("the review loop runs on its phases", () => {
  effect(
    "review, address-review and re-review each find the pull request by its record, as the last one left it",
    () =>
      Effect.gen(function* () {
        const fake = makeFake(["request-changes", "approve"]);
        asReviewer(fake);
        fake.people.requested = ["data-quail"];
        fake.recordPhase(ITEM, "review-asked");
        expect(yield* keys(fake, review)).toEqual([ITEM]);

        yield* runToEnd(reviewing, fake, reviewWork(ITEM));
        expect(fake.phases()).toEqual({ [ITEM]: "changes-asked" });
        expect(yield* keys(fake, review)).toEqual([]);

        asAuthor(fake);
        implemented(fake);
        const [addressKey] = yield* keys(fake, addressReview);
        expect(addressKey).toBe(`${ITEM}-changes-asked-v2`);

        const addressed = yield* runToEnd(addressing, fake, addressWork(addressKey));
        expect(addressed.status).toBe("done");
        expect(fake.phases()).toEqual({ [ITEM]: "review-asked-again" });
        expect(yield* keys(fake, addressReview)).toEqual([]);

        asReviewer(fake);
        const [againKey] = yield* keys(fake, reReview);
        expect(againKey).toBe(`${ITEM}-review-asked-again-v3`);
        expect(yield* keys(fake, review)).toEqual([]);

        const approved = yield* runToEnd(reReviewing, fake, reviewWork(againKey));
        expect(summaryOf(approved)).toBe(`#${PULL} approved; a person merges`);
        expect(fake.phases()).toEqual({ [ITEM]: "approved" });
        expect(yield* keys(fake, reReview)).toEqual([]);
      }),
  );

  effect("a pull request from before phases, with no record, still goes round the loop", () =>
    Effect.gen(function* () {
      const fake = changesAskedOnHead();
      implemented(fake);
      expect(yield* keys(fake, addressReview)).toEqual([`${ITEM}-changes-1`]);

      const addressed = yield* runToEnd(addressing, fake, addressWork(`${ITEM}-changes-1`));
      expect(addressed.status).toBe("done");
      expect(fake.phases()).toEqual({ [ITEM]: "review-asked-again" });

      asReviewer(fake);
      expect(yield* keys(fake, reReview)).toEqual([`${ITEM}-review-asked-again-v1`]);
    }),
  );

  effect("a review requested of a pull request with no record is its first by the count", () =>
    Effect.gen(function* () {
      const fake = makeFake(["approve"]);
      asReviewer(fake);
      fake.people.requested = ["data-quail"];
      expect(yield* keys(fake, review)).toEqual([ITEM]);

      fake.submitted.push({ author: "data-quail", state: "COMMENTED", commitSha: HEAD });
      expect(yield* keys(fake, review)).toEqual([]);
      expect(yield* keys(fake, reReview)).toEqual([`${ITEM}-review-2`]);
    }),
  );
});

describe("an accidental change on GitHub doesn't move a phase", () => {
  effect("labels and assignees that come and go leave address-review's work as it was", () =>
    Effect.gen(function* () {
      const fake = changesAskedOnHead(Option.some("changes-asked"));
      const before = yield* keys(fake, addressReview);
      expect(before).toEqual([`${ITEM}-changes-asked-v1`]);

      fake.setLabels(PULL, [DEFAULT_LABELS.approved, DEFAULT_LABELS.needsReview, "docs"]);
      fake.people.pullAssigned = ["zach"];
      expect(yield* keys(fake, addressReview)).toEqual(before);

      fake.setLabels(PULL, []);
      fake.people.pullAssigned = [];
      expect(yield* keys(fake, addressReview)).toEqual(before);
      expect(fake.phases()).toEqual({ [ITEM]: "changes-asked" });
    }),
  );

  effect("a review count that changes doesn't make a request to review again new work", () =>
    Effect.gen(function* () {
      const fake = makeFake(["approve"]);
      asReviewer(fake);
      fake.people.requested = ["data-quail"];
      fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
      fake.recordPhase(ITEM, "review-asked-again");
      const before = yield* keys(fake, reReview);
      expect(before).toEqual([`${ITEM}-review-asked-again-v1`]);

      fake.submitted.push({ author: "data-quail", state: "COMMENTED", commitSha: HEAD });
      fake.setLabels(PULL, [DEFAULT_LABELS.changesRequested]);
      expect(yield* keys(fake, reReview)).toEqual(before);
      expect(yield* keys(fake, review)).toEqual([]);
      expect(fake.phases()).toEqual({ [ITEM]: "review-asked-again" });
    }),
  );
});

describe("a fact no run was there to record moves the record on", () => {
  effect("a person's review that asks for changes on the head starts address-review", () =>
    Effect.gen(function* () {
      const fake = makeFake(["approve"]);
      fake.recordPhase(ITEM, "review-asked");
      expect(yield* keys(fake, addressReview)).toEqual([]);

      fake.submitted.push({ author: "zach", state: "CHANGES_REQUESTED", commitSha: HEAD });
      expect(yield* keys(fake, addressReview)).toEqual([`${ITEM}-changes-asked-v2`]);
      expect(fake.phases()).toEqual({ [ITEM]: "changes-asked" });
      expect(yield* keys(fake, addressReview)).toEqual([`${ITEM}-changes-asked-v2`]);
    }),
  );

  effect("a person asking for a review again, after changes asked, starts re-review", () =>
    Effect.gen(function* () {
      const fake = changesAskedOnHead(Option.some("changes-asked"));
      asReviewer(fake);
      fake.git.head = FIX;
      fake.people.requested = ["data-quail"];
      expect(yield* keys(fake, reReview)).toEqual([`${ITEM}-review-asked-again-v2`]);
      expect(fake.phases()).toEqual({ [ITEM]: "review-asked-again" });
    }),
  );

  effect("a person's request leaves a pull request a person has alone", () =>
    Effect.gen(function* () {
      const fake = changesAskedOnHead(Option.some("changes-asked"));
      asReviewer(fake);
      fake.people.requested = ["data-quail"];
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      expect(yield* keys(fake, reReview)).toEqual([]);
      expect(fake.phases()).toEqual({ [ITEM]: "changes-asked" });
    }),
  );
});

describe("a record GitHub disagrees with is held, with why", () => {
  effect("changes asked, but the head moved since without a request to review again", () =>
    Effect.gen(function* () {
      const fake = changesAskedOnHead(Option.some("changes-asked"));
      fake.git.head = FIX;
      expect(yield* helds(fake, addressReview)).toEqual([
        `#${PULL}: changes were asked at abc1234, but its head has moved to fix2000 since; ask data-quail to review again`,
      ]);
    }),
  );

  effect("changes asked, but the latest review approves", () =>
    Effect.gen(function* () {
      const fake = changesAskedOnHead(Option.some("changes-asked"));
      fake.submitted.push({ author: "zach", state: "APPROVED", commitSha: HEAD });
      expect(yield* helds(fake, addressReview)).toEqual([
        `#${PULL}: its record says changes asked, but its latest review asks for none`,
      ]);
    }),
  );
});

describe("a pull request this persona reviewed before its hand-off", () => {
  effect(
    "an adopted one, asked of the persona that reviewed it before, goes to re-review rather than being held",
    () =>
      Effect.gen(function* () {
        // A person's pull request data-quail reviewed, then adopted and handed
        // off, which records review-asked, and the pool asks data-quail again.
        const fake = makeFake(["approve"]);
        asReviewer(fake);
        fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
        fake.recordPhase(ITEM, "review-asked");
        fake.people.requested = ["data-quail"];

        expect(yield* triggered(fake, review)).toEqual([]);
        expect(yield* keys(fake, reReview)).toEqual([`${ITEM}-review-asked-again-v2`]);
        expect(fake.phases()).toEqual({ [ITEM]: "review-asked-again" });
      }),
  );
});

describe("a closed or merged pull request ends its record", () => {
  for (const state of ["closed", "merged"] as const) {
    effect(`whatever the record says, nothing picks up one ${state}`, () =>
      Effect.gen(function* () {
        const asked = changesAskedOnHead(Option.some("changes-asked"));
        asked.states.pull = state;
        expect(yield* triggered(asked, addressReview)).toEqual([]);

        const again = makeFake(["approve"]);
        asReviewer(again);
        again.people.requested = ["data-quail"];
        again.recordPhase(ITEM, "review-asked");
        again.states.pull = state;
        expect(yield* triggered(again, review)).toEqual([]);
        expect(yield* triggered(again, reReview)).toEqual([]);
      }),
    );
  }
});

describe("a document's progress.advance", () => {
  // The review document, with a team's own phase recorded after changes are asked.
  const CHANGES_END = `      changes:
        steps:
          - end: done`;

  const triaging = () => {
    expect(REVIEW_DOCUMENT).toContain(CHANGES_END);

    return loadFlow(
      documentOf(
        REVIEW_DOCUMENT.replace(
          CHANGES_END,
          `      changes:
        steps:
          - id: triaged
            use: progress.advance
            with: { phase: triaged }
          - end: done`,
        ),
      ),
    );
  };

  effect("records the team's phase on the run's pull request, after the review's own", () =>
    Effect.gen(function* () {
      const flow = yield* triaging();

      const observed = yield* observe(
        flow,
        "review",
        () => reviewAsked("request-changes"),
        REVIEW_WORK_ITEM,
      );

      expect(observed.status).toBe("done");
      expect(observed.steps).toContain("progress-triaged");
      expect(observed.phases).toEqual({ [ITEM]: "triaged" });
    }),
  );
});
