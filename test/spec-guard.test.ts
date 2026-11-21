// A pull request that changes a behavior spec goes to a person (ADR 22,
// decision 3, #579): the review, re-review and address-review flows hand it
// over before they work on it, and the merge gate before it merges, until a
// person, not a persona, approves a head with the same feature files.

import {
  DEFAULT_LABELS,
  defineFlow,
  type Flow,
  PullRequest,
  StepFailed,
  type SubmittedReview,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import addressReview from "../packages/recipes/flows/address-review.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import review from "../packages/recipes/flows/review.ts";
import { approvedHeads, featureFilesIn, isPerson } from "../packages/sdk/src/spec-guard.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  flowTriggered,
  HEAD,
  item,
  makeFake,
  PULL,
  repoAs,
  runToEnd,
  settings,
  summaryOf,
} from "./sdk-fakes.ts";

const FEATURE = "test/features/review-loop.feature";
const ENTRY = "test/features/review-loop.test.ts";

// The repo's personas, by its committed config: the author and its reviewer.
const PERSONAS = ["chernabog-bot", "data-quail"];
const repo = repoAs({ ...settings, personas: PERSONAS });

const reviewing = flowHandle(repo, "review", review);
const reReviewing = flowHandle(repo, "re-review", reReview);
const addressing = flowHandle(repo, "address-review", addressReview);

const data = { pullRequest: PULL, headRef: "auto/issue-3", agentWritten: true };
const firstReview = item(`pr-${PULL}`, data);
const againReview = item(`pr-${PULL}-review-asked-again-v2`, data);

const addressWork = item(`pr-${PULL}-changes-1`, {
  ...data,
  reviewer: "data-quail",
  reviewedSha: HEAD,
});

// The feature files a commit holds: the spec, at `spec`, and its entry file,
// agent-owned plumbing beside it, at `entry`.
const holds = (fake: Fake, sha: string, spec: string, entry = "entry-1") => {
  fake.trees.set(sha, [
    { path: FEATURE, sha: spec },
    { path: ENTRY, sha: entry },
  ]);
};

// A pull request whose diff touches a feature file, asking data-quail, the
// persona the run acts as, for a review.
const changingSpec = (labels: ReadonlyArray<string> = []) => {
  const fake = makeFake(["approve"], { personas: PERSONAS });
  fake.people.me = "data-quail";
  fake.people.requested = ["data-quail"];
  fake.setLabels(PULL, [...labels]);
  fake.merge.files = [FEATURE, "src/a.ts"];
  holds(fake, HEAD, "spec-1");

  return fake;
};

const approval = (author: string, commitSha: string, trusted = true): SubmittedReview => ({
  author,
  state: "APPROVED",
  commitSha,
  trusted,
});

// What the hand-offs to a person said, in turn.
const handOffs = (fake: Fake) =>
  fake.comments
    .map((comment) => comment.body)
    .filter((body) => body.startsWith("Chernabog stopped and needs a person"));

// Handed to a person, with why, and nothing else done: no review, no agent, no merge.
const handedOver = (fake: Fake, status: string) => {
  expect(status).toBe("needs-human");
  expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
  expect(handOffs(fake).at(-1)).toContain(`\`${FEATURE}\``);
  expect(fake.requests).toEqual([]);
  expect(fake.merge.requests).toEqual([]);
};

const keys = (fake: Fake, flow: Flow) =>
  Effect.map(flowTriggered(fake, flow), (items) => items.map((found) => found.key));

describe("a pull request that changes a feature file", () => {
  effect("goes to a person from review, unreviewed", () =>
    Effect.gen(function* () {
      const fake = changingSpec([DEFAULT_LABELS.ship]);
      const finished = yield* runToEnd(reviewing, fake, firstReview);

      handedOver(fake, finished.status);
      expect(fake.submitted).toEqual([]);
      expect(summaryOf(finished)).toContain("only a person approves");
    }),
  );

  effect("goes to a person from re-review, unreviewed", () =>
    Effect.gen(function* () {
      const fake = changingSpec([DEFAULT_LABELS.ship]);
      fake.recordReview({
        sha: HEAD,
        round: 1,
        verdict: "request-changes",
        reviewer: "data-quail",
        sessionId: "review-session",
        adapter: "codex",
      });

      const finished = yield* runToEnd(reReviewing, fake, againReview);

      handedOver(fake, finished.status);
      expect(fake.submitted).toEqual([]);
    }),
  );

  effect("goes to a person from address-review, unanswered and unpushed", () =>
    Effect.gen(function* () {
      const fake = changingSpec();
      fake.people.me = "chernabog-bot";
      fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
      fake.recordPhase(`pr-${PULL}`, "changes-asked");
      fake.git.pushes = 1;

      const finished = yield* runToEnd(addressing, fake, addressWork);

      handedOver(fake, finished.status);
      expect(handOffs(fake)).toHaveLength(1);
      expect(fake.git.pushes).toBe(1);
    }),
  );

  // A flow that merges straight away, as an epic's round lands a layer.
  const merging = flowHandle(
    repo,
    "merging",
    defineFlow({
      trigger: Effect.succeed([]),
      workflow: () =>
        PullRequest.merge(PULL, { method: "squash" }).pipe(
          Effect.catchTags({
            MergeRefused: (refused) =>
              Effect.fail(new StepFailed({ step: "merge", message: refused.message })),
            PullRequestClosed: (closed) =>
              Effect.fail(new StepFailed({ step: "merge", message: closed.message })),
            NotFound: (gone) =>
              Effect.fail(new StepFailed({ step: "merge", message: gone.message })),
          }),
        ),
    }),
  );

  effect("goes to a person from the merge gate, approved and green, so no persona merges it", () =>
    Effect.gen(function* () {
      const fake = changingSpec([DEFAULT_LABELS.ship]);
      fake.recordReview({ sha: HEAD, round: 1, verdict: "approve" });

      const finished = yield* runToEnd(merging, fake, item("merge"));

      handedOver(fake, finished.status);

      // The same pull request without the spec merges.
      const plain = changingSpec([DEFAULT_LABELS.ship]);
      plain.merge.files = ["src/a.ts"];
      plain.recordReview({ sha: HEAD, round: 1, verdict: "approve" });
      expect((yield* runToEnd(merging, plain, item("merge"))).status).toBe("done");
      expect(plain.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  effect("still goes to a person when a persona, a bot or an untrusted login approved it", () =>
    Effect.gen(function* () {
      const fake = changingSpec([DEFAULT_LABELS.ship]);
      fake.submitted.push(
        approval("data-quail", HEAD),
        approval("Chernabog-Bot", HEAD),
        approval("renovate[bot]", HEAD),
        approval("drive-by", HEAD, false),
      );

      const finished = yield* runToEnd(reviewing, fake, firstReview);

      handedOver(fake, finished.status);
    }),
  );

  effect("comes back to a person when the label is removed without a person's approval", () =>
    Effect.gen(function* () {
      const fake = changingSpec();
      handedOver(fake, (yield* runToEnd(reviewing, fake, firstReview)).status);

      // While a person has it, no review flow takes it up.
      expect(yield* keys(fake, review)).toEqual([]);

      // An agent, or anyone, removes the label: the next run puts it back.
      fake.setLabels(PULL, []);
      expect(yield* keys(fake, review)).toEqual([`pr-${PULL}`]);

      const again = yield* runToEnd(reviewing, fake, firstReview);
      handedOver(fake, again.status);
      expect(fake.submitted).toEqual([]);
    }),
  );

  effect("is reviewed and merged once a person approved a head with the same feature files", () =>
    Effect.gen(function* () {
      const fake = changingSpec([DEFAULT_LABELS.ship]);
      // zach approved an earlier head: its spec is this head's, its plumbing isn't.
      holds(fake, "older1234", "spec-1", "entry-0");
      fake.submitted.push(approval("zach", "older1234"));

      const finished = yield* runToEnd(reviewing, fake, firstReview);

      expect(finished.status).toBe("done");
      expect(fake.labelsOf(PULL)).not.toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.submitted.at(-1)).toEqual({
        author: "data-quail",
        state: "APPROVED",
        commitSha: HEAD,
      });
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  effect("needs a person's approval again once a push changes the feature files", () =>
    Effect.gen(function* () {
      const fake = changingSpec();
      fake.submitted.push(approval("zach", HEAD));

      // The spec as zach approved it, on its head: cleared.
      expect((yield* runToEnd(reviewing, fake, firstReview)).status).toBe("done");

      // A later push edits the spec, and the review is asked again.
      fake.git.head = "fix2000000";
      holds(fake, fake.git.head, "spec-2");
      fake.people.requested = ["data-quail"];
      fake.requests.splice(0);

      handedOver(fake, (yield* runToEnd(reReviewing, fake, againReview)).status);
      expect(handOffs(fake).at(-1)).toContain("changed since a person last approved");

      // zach approves the new head, and the label comes off: it goes on.
      fake.submitted.push(approval("zach", fake.git.head));
      fake.setLabels(PULL, []);

      const cleared = yield* runToEnd(
        reReviewing,
        fake,
        item(`pr-${PULL}-review-asked-again-v3`, data),
      );

      expect(cleared.status).not.toBe("needs-human");
      expect(fake.labelsOf(PULL)).not.toContain(DEFAULT_LABELS.needsHuman);
    }),
  );
});

describe("who clears it", () => {
  test("a person's latest decisive review: an approval, never one withdrawn or dismissed", () => {
    expect(
      approvedHeads(
        [
          approval("zach", "a"),
          approval("erin", "b"),
          { author: "zach", state: "COMMENTED", commitSha: "c", trusted: true },
          { author: "erin", state: "CHANGES_REQUESTED", commitSha: "c", trusted: true },
          { author: "kim", state: "DISMISSED", commitSha: "d", trusted: true },
          approval("lee", "e"),
          approval("Zach", "f"),
        ],
        PERSONAS,
      ),
    ).toEqual(["f", "e"]);
  });

  test("a person is no persona, under any case, and no bot", () => {
    expect(isPerson("zach", PERSONAS)).toBe(true);
    expect(isPerson("Data-Quail", PERSONAS)).toBe(false);
    expect(isPerson("dependabot[bot]", PERSONAS)).toBe(false);
    expect(isPerson("", PERSONAS)).toBe(false);
  });

  test("the feature files are .feature files under test/features, at any depth", () => {
    expect(
      featureFilesIn([
        "test/features/review.feature",
        "test/features/loop/merge.feature",
        "test/features/review.test.ts",
        "test/acceptance/review.feature",
        "features/review.feature",
      ]),
    ).toEqual(["test/features/review.feature", "test/features/loop/merge.feature"]);
  });

  test("a review's absent trust is taken as none", () => {
    expect(
      approvedHeads([{ author: "zach", state: "APPROVED", commitSha: "a" }], PERSONAS),
    ).toEqual([]);
  });
});
