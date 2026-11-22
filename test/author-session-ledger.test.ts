// The author's session is in the ledger (ADR 21, decision 7; #565): the
// implement run's hand-off keeps it in the issue's handed-off record, naming
// the pull request, so address-review resumes it whatever happened to the
// comment that tells people about it.

import { DEFAULT_LABELS, Phases, reviewMarker } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import implement from "../packages/recipes/flows/implement.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { type Fake, HEAD, ISSUE, item, makeFake, PULL, repo, runToEnd } from "./sdk-fakes.ts";

const implementing = flowHandle(repo, "implement", implement);
const addressing = flowHandle(repo, "address-review", addressReview);
const POOL = { reviewers: ["zach", "data-quail"] };

const addressWork = item(`pr-${PULL}-changes-1`, {
  pullRequest: PULL,
  headRef: `auto/issue-${ISSUE}`,
  agentWritten: true,
  reviewer: "data-quail",
  reviewedSha: HEAD,
});

// data-quail asks for changes on the head, as review.round records it.
const changesAsked = (fake: Fake) => {
  fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
  fake.recordPhase(Phases.pullRequestItem(PULL), Phases.PHASES.pullRequest.changesAsked);
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
};

// The implement run on a queued issue, to its hand-off: the session it implemented in.
const implemented = (fake: Fake) =>
  Effect.gen(function* () {
    fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
    const finished = yield* runToEnd(implementing, fake, item(`issue-${ISSUE}`, { issue: ISSUE }));
    expect(finished.status).toBe("done");

    return yield* Effect.fromOption(Option.fromUndefinedOr(fake.requests[0]?.sessionId)).pipe(
      Effect.orDie,
    );
  });

describe("the author's session", () => {
  effect(
    "is resumed by address-review from the issue's record, with every comment on the pull request deleted",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        const session = yield* implemented(fake);

        // A person deletes every comment the hand-off left; the review comes after.
        fake.comments.splice(0);
        changesAsked(fake);
        const before = fake.requests.length;

        const finished = yield* runToEnd(addressing, fake, addressWork);

        expect(finished.status).toBe("done");
        expect(fake.requests.slice(before).map((request) => request.sessionId)).toEqual([
          session,
          session,
        ]);
      }),
  );

  effect(
    "is not read back from a session comment: with no record naming the pull request, address-review starts a fresh one",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.git.pushes = 1;
        fake.comment(
          `Implemented by claude for #${ISSUE}. <!-- chernabog-session {"adapter":"claude","sessionId":"implement-session","issue":${ISSUE},"branch":"auto/issue-${ISSUE}"} -->`,
        );
        changesAsked(fake);

        const finished = yield* runToEnd(addressing, fake, addressWork);

        expect(finished.status).toBe("done");
        expect(fake.requests.map((request) => request.sessionId)).not.toContain(
          "implement-session",
        );
      }),
  );
});
