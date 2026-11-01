// The SDK's steps and triggers against an in-memory GitHub: which of them move
// labels, which leave that to a separate step, and who owns a pull request.

import {
  activity,
  awaitSignal,
  claimMarker,
  DEFAULT_LABELS,
  defineFlow,
  GitHub,
  Hybrid,
  Implement,
  Issue,
  NeedsHuman,
  ownerMarker,
  PullRequest,
  Review,
  reviewMarker,
  Run,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import implement from "../packages/recipes/flows/implement.ts";
import reviewFlow from "../packages/recipes/flows/review.ts";
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
  PULL,
  repo,
  type RunsServices,
  runToEnd as runFlowToEnd,
  runUntil as runFlowUntil,
  stackOn,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const SHIP = "auto:ship";

// Another task's branch, which a task stacked on it is built on.
const STACKED = "auto/issue-12";
const STACKED_HEAD = "stacked1234";

const outcome = {
  status: "done" as const,
  summary: "Did it.",
  title: "feat: a change",
  body: "The change.",
};

const opened = { number: PULL, url: `https://github.com/dataquail/demo/pull/${PULL}` };

// The implement blocks from claim to the pull request, each on the base the claim settled.
const implementOn = (options: Implement.BaseOptions) =>
  Effect.gen(function* () {
    const claimed = yield* Implement.claim(ISSUE, options);
    const base = { base: claimed.base };
    const worktree = yield* Implement.prepareWorktree(claimed.branch);
    const done = yield* Implement.implementWithAgent(ISSUE, worktree, base);
    yield* Implement.push("push", worktree, claimed.branch, base);

    return (yield* Implement.openPullRequest(ISSUE, done, base)).url;
  });

// Each item key names the steps its run takes.
const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    Effect.gen(function* () {
      if (work.key === "round") {
        return (yield* Review.round(PULL, 1)).verdict;
      }

      if (work.key === "round-as-reviewer") {
        return (yield* Review.round(PULL, 1, { role: "reviewer" })).verdict;
      }

      if (work.key === "hand-off") {
        return yield* Implement.handOff(ISSUE, opened, outcome);
      }

      if (work.key === "on-repo-base") {
        return yield* implementOn({});
      }

      if (work.key === "on-stacked-base") {
        return yield* implementOn({ base: STACKED });
      }

      if (work.key === "hybrid-on-stacked-base") {
        const claimed = yield* Hybrid.claim(ISSUE, { base: STACKED });
        const base = { base: claimed.base };
        const worktree = yield* Implement.prepareWorktree(claimed.branch);
        const finished = yield* Hybrid.workWithPerson(ISSUE, worktree, base);
        yield* Implement.push("push", worktree, claimed.branch, { ...base, withPerson: true });

        return (yield* Hybrid.openPullRequest(ISSUE, finished, base)).url;
      }

      // As a run that stopped inside claim, after its comment, finds the issue
      // when it resumes: its branch made, and its claim marker naming its base.
      if (work.key === "resumed-claim") {
        yield* activity(
          "claimed-before",
          Effect.gen(function* () {
            const run = yield* Run;
            yield* (yield* GitHub).comment(
              ISSUE,
              claimMarker.write({
                runId: run.runId,
                claimedAt: "2026-10-28T00:00:00Z",
                branch: `auto/issue-${ISSUE}`,
                base: STACKED,
                ref: true,
              }),
            );
          }),
        );

        return yield* implementOn({});
      }

      if (work.key === "claim-ship") {
        return (yield* Implement.claim(ISSUE, { label: SHIP })).branch;
      }

      if (work.key === "owning") {
        return yield* PullRequest.owning(PULL)(Review.round(PULL, 1)).pipe(
          Effect.map((review) => review.verdict),
        );
      }

      if (work.key === "owning-fails") {
        return yield* PullRequest.owning(PULL)(Effect.fail(new NeedsHuman({ reason: "stuck" })));
      }

      if (work.key === "owning-waits") {
        return yield* PullRequest.owning(PULL)(
          awaitSignal(["pushed"], { id: "wait", timeout: "1 hour" }),
        );
      }

      if (work.key === "recheck") {
        const review = yield* Review.round(PULL, 1, { role: "reviewer" });
        const recheck = yield* Review.recheck(PULL, review);

        return `${recheck.round}: ${recheck.findings.map((finding) => `${finding.finding} ${finding.remediated}`).join(", ")}`;
      }

      if (work.key === "recheck-verdict") {
        const review = yield* Review.round(PULL, 1, { role: "reviewer" });
        const recheck = yield* Review.recheck(PULL, review);

        return `${review.verdict} then ${recheck.verdict}`;
      }

      if (work.key === "address") {
        const review = yield* Review.round(PULL, 1);
        const addressed = yield* Implement.addressFindings(PULL, review, Implement.thisRunsSession);

        return addressed.summary;
      }

      if (work.key === "consider-and-address") {
        const review = yield* Review.round(PULL, 1);
        const decision = yield* Implement.considerFindings(PULL, review, Implement.thisRunsSession);
        const addressed = yield* Implement.addressFindings(PULL, review, Implement.thisRunsSession);

        return `${decision.status}: ${addressed.summary}`;
      }

      if (work.key === "comments") {
        yield* PullRequest.comment(PULL, "On the pull request.");
        yield* Issue.comment(ISSUE, "On the issue.");
        yield* PullRequest.comment(PULL, "On the pull request.");
      }

      // A refused merge is the flow's to decide on; this one hands it to a person.
      if (work.key === "merge") {
        return yield* PullRequest.merge(PULL, { method: "squash" }).pipe(
          Effect.catchTag("MergeRefused", (refused) =>
            Effect.fail(new NeedsHuman({ reason: refused.message })),
          ),
        );
      }

      if (work.key === "hand-off-unlabelled") {
        return yield* Implement.handOff(ISSUE, opened, outcome, { needsReview: false });
      }
    }).pipe(
      Effect.catchTags({
        NotFound: (gone) => Effect.fail(new StepFailed({ step: work.key, message: gone.message })),
        PullRequestClosed: (closed) =>
          Effect.fail(new StepFailed({ step: work.key, message: closed.message })),
        NothingCommitted: (nothing) =>
          Effect.fail(new StepFailed({ step: work.key, message: nothing.message })),
        PushRejected: (rejected) =>
          Effect.fail(new StepFailed({ step: work.key, message: rejected.message })),
      }),
    ),
});

const handle = flowHandle(repo, "demo", flow);

const runUntil = (
  fake: Fake,
  key: string,
  until: (run: EngineRun) => Effect.Effect<boolean, never, RunsServices>,
) => runFlowUntil(handle, fake, item(key), until);

const runToEnd = (fake: Fake, key: string) => runFlowToEnd(handle, fake, item(key));

// The flow in a repo whose settings let a failing optional check through.
const ignoringOptional = flowHandle(
  {
    ...repo,
    personas: Arr.map(repo.personas, (persona) => ({
      ...persona,
      shared: { ciOptionalFailures: "ignore" },
    })),
  },
  "demo",
  flow,
);

describe("the review steps", () => {
  effect(
    "Review.round posts a real review and its marker, naming the reviewer and its session, and leaves the labels alone",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("request-changes");
        fake.people.me = "data-quail";
        const finished = yield* runToEnd(fake, "round");
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe("request-changes");
        expect(fake.reviews).toHaveLength(1);
        expect(fake.submitted).toEqual([
          { author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD },
        ]);

        const markers = fake.comments.flatMap((comment) =>
          Option.toArray(reviewMarker.read(comment.body)),
        );

        expect(markers).toEqual([
          {
            sha: HEAD,
            round: 1,
            verdict: "request-changes",
            reviewer: "data-quail",
            sessionId: fake.requests[0]?.sessionId,
            adapter: "claude",
          },
        ]);
        expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
      }),
  );
});

describe("agents per role", () => {
  const roles = {
    flowAgents: { demo: "opencode" },
    flowRoleAgents: { demo: { reviewer: "codex" } },
  };

  effect("a step given a role runs with that role's adapter", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", roles);
      expect((yield* runToEnd(fake, "round-as-reviewer")).status).toBe("done");
      expect(fake.adapters).toEqual([Option.some("codex")]);
      expect(fake.reviews[0]).toContain("Approved by codex");
    }),
  );

  effect(
    "a step without a role, or with one the flow does not name, falls back to the flow's agent",
    () =>
      Effect.gen(function* () {
        const plain = makeFake("approve", roles);
        expect((yield* runToEnd(plain, "round")).status).toBe("done");

        const unnamed = makeFake("approve", {
          ...roles,
          flowRoleAgents: { demo: { author: "codex" } },
        });

        expect((yield* runToEnd(unnamed, "round-as-reviewer")).status).toBe("done");
        expect([...plain.adapters, ...unnamed.adapters]).toEqual([
          Option.some("opencode"),
          Option.some("opencode"),
        ]);
      }),
  );

  effect("and with no flow agent either, the repo's", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect((yield* runToEnd(fake, "round-as-reviewer")).status).toBe("done");
      expect(fake.adapters).toEqual([Option.none()]);
      expect(fake.reviews[0]).toContain("Approved by claude");
    }),
  );
});

describe("a flow keyed by its own label", () => {
  effect("Implement.triggerFor finds issues with that label, and claim takes the label off", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, ["auto:queued"]);
      const found = yield* triggered(fake, Implement.triggerFor("auto:queued"));
      expect(found.map((work) => work.data)).toEqual([{ issue: ISSUE, label: "auto:queued" }]);
      expect(yield* flowTriggered(fake, implement)).toEqual([]);
      // auto:ship queues an issue too, the automated path, and says so for claim and openPullRequest.
      fake.setLabels(ISSUE, [SHIP]);
      expect((yield* flowTriggered(fake, implement)).map((work) => work.data)).toEqual([
        { issue: ISSUE, label: SHIP },
      ]);

      expect((yield* runToEnd(fake, "claim-ship")).status).toBe("done");
      // The queue label is gone; the in-progress label claim put on goes when the run ends.
      expect(fake.labelsOf(ISSUE)).toEqual([]);
    }),
  );
});

const claimedOn = (fake: Fake) =>
  fake.comments.flatMap((comment) =>
    Option.toArray(Option.map(claimMarker.read(comment.body), (claim) => claim.base)),
  );

describe("a base branch per item", () => {
  effect(
    "without one, the implement blocks build on the repo's base branch, as they always have",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        expect((yield* runToEnd(fake, "on-repo-base")).status).toBe("done");
        expect(fake.based).toEqual({
          createdFrom: ["base1234"],
          targets: ["main"],
          checkedAgainst: ["main", "main"],
          compared: [],
        });
        expect(fake.requests[0]?.prompt).toContain("cut from `main`");
        expect(claimedOn(fake)).toEqual(["main"]);
      }),
  );

  effect(
    "the flow's base setting, such as develop in git flow, is what they build on and target",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        fake.remote.heads.set("develop", "develop1234");

        const onDevelop = flowHandle(
          { ...repo, personas: [{ ...repo.personas[0], shared: { base: "develop" } }] },
          "demo",
          flow,
        );

        expect((yield* runFlowToEnd(onDevelop, fake, item("on-repo-base"))).status).toBe("done");
        expect(fake.based).toEqual({
          createdFrom: ["develop1234"],
          targets: ["develop"],
          checkedAgainst: ["develop", "develop"],
          compared: [],
        });
        expect(claimedOn(fake)).toEqual(["develop"]);
      }),
  );

  effect(
    "given another task's branch, the claim branch starts from its head, the checks diff against it, and the pull request targets it",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        fake.remote.heads.set(STACKED, STACKED_HEAD);
        expect((yield* runToEnd(fake, "on-stacked-base")).status).toBe("done");
        expect(fake.based).toEqual({
          createdFrom: [STACKED_HEAD],
          targets: [STACKED],
          // The no-commits check and the humanOnlyPaths check: the task's own diff, not the task below's.
          checkedAgainst: [STACKED, STACKED],
          compared: [],
        });
        expect(fake.requests[0]?.prompt).toContain(`cut from \`${STACKED}\``);
        expect(claimedOn(fake)).toEqual([STACKED]);
      }),
  );

  effect("so do the hybrid blocks, for a person's start", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.remote.heads.set(STACKED, STACKED_HEAD);
      expect((yield* runToEnd(fake, "hybrid-on-stacked-base")).status).toBe("done");
      expect(fake.based).toEqual({
        createdFrom: [STACKED_HEAD],
        targets: [STACKED],
        // With a person in the session, only the no-commits check runs.
        checkedAgainst: [STACKED],
        compared: [],
      });
      expect(fake.requests[0]?.prompt).toContain(`cut from \`${STACKED}\``);
      expect(claimedOn(fake)).toEqual([STACKED]);
    }),
  );

  effect(
    "a base that is gone fails the claim, with the reason, rather than building on the repo's",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        fake.remote.gone.add(STACKED);
        const failed = yield* runToEnd(fake, "on-stacked-base");
        expect(failed.status).toBe("failed");
        expect(summaryOf(failed)).toContain(`base branch ${STACKED} not found`);
        expect(fake.based.createdFrom).toEqual([]);
        expect(fake.requests).toEqual([]);
      }),
  );

  effect("a resumed claim keeps the base the run claimed the issue on", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.existing.branch = true;
      expect((yield* runToEnd(fake, "resumed-claim")).status).toBe("done");
      expect(fake.based.targets).toEqual([STACKED]);
      expect(fake.based.checkedAgainst).toEqual([STACKED, STACKED]);
      expect(fake.requests[0]?.prompt).toContain(`cut from \`${STACKED}\``);
    }),
  );
});

const ownership = (fake: Fake) =>
  fake.comments
    .flatMap((comment) => Option.toArray(ownerMarker.read(comment.body)))
    .map((marker) => marker.released);

// Asks the fake's persona to review the pull request.
const requested = (fake: Fake) => {
  fake.people.requested = [fake.people.me];

  return fake;
};

describe("owning a pull request", () => {
  effect(
    "PullRequest.owning marks the pull request as the run's, and lets it go when the run ends",
    () =>
      Effect.gen(function* () {
        const done = makeFake("approve");
        expect((yield* runToEnd(done, "owning")).status).toBe("done");
        expect(ownership(done)).toEqual([false, true]);

        const failed = makeFake("approve");
        expect((yield* runToEnd(failed, "owning-fails")).status).toBe("needs-human");
        expect(ownership(failed)).toEqual([false, true]);
      }),
  );

  effect("a run waiting on a signal keeps the pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* runUntil(fake, "owning-waits", (run) =>
        listRunWaitsHandler({ runId: run.id, signal: "pushed" }).pipe(
          Effect.map(({ waits }) => waits.length > 0),
        ),
      );
      expect(ownership(fake)).toEqual([false]);
    }),
  );

  const owned = (fake: Fake, released: boolean) => {
    fake.comment(ownerMarker.write({ flow: "ship", runId: "demo.ship.issue-3.1", released }));
  };

  effect(
    "the review and address-review recipes' triggers leave alone a pull request another run owns",
    () =>
      Effect.gen(function* () {
        const review = requested(makeFake("approve"));
        owned(review, false);
        expect(yield* flowTriggered(review, reviewFlow)).toEqual([]);

        const address = makeFake("approve");
        address.submitted.push({
          author: "data-quail",
          state: "CHANGES_REQUESTED",
          commitSha: HEAD,
        });
        expect((yield* flowTriggered(address, addressReview)).length).toBe(1);
        owned(address, false);
        expect(yield* flowTriggered(address, addressReview)).toEqual([]);
      }),
  );

  effect("and pick it up again once the run lets go, or this machine knows the run ended", () =>
    Effect.gen(function* () {
      const released = requested(makeFake("approve"));
      owned(released, false);
      owned(released, true);
      expect((yield* flowTriggered(released, reviewFlow)).map((work) => work.key)).toEqual([
        `pr-${PULL}`,
      ]);

      // A run this machine doesn't know, such as one on another machine, still owns it.
      const ended = requested(makeFake("approve"));
      owned(ended, false);
      expect(yield* flowTriggered(ended, reviewFlow)).toEqual([]);
      ended.knowRun(false);
      expect((yield* flowTriggered(ended, reviewFlow)).map((work) => work.key)).toEqual([
        `pr-${PULL}`,
      ]);
    }),
  );
});

describe("considering findings", () => {
  const roles = { flowRoleAgents: { demo: { reviewer: "codex" } } };

  effect(
    "Review.recheck resumes the reviewer's session with the change since its review, and posts the next review",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", roles);
        const finished = yield* runToEnd(fake, "recheck");
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe("2: Mention the change true");

        const [review, recheck] = fake.requests;
        expect(recheck.sessionId).toBe(review.sessionId);
        expect(recheck.adapter).toEqual(Option.some("codex"));
        expect(Option.getOrElse(recheck.resumePrompt, () => "")).toContain(
          `git diff ${HEAD}..HEAD`,
        );

        const markers = fake.comments.flatMap((comment) =>
          Option.toArray(reviewMarker.read(comment.body)),
        );

        expect(markers.map((marker) => marker.round)).toEqual([1, 2]);
      }),
  );

  effect(
    "Implement.considerFindings and addressFindings resume the implement session with the review",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("request-changes");
        const finished = yield* runToEnd(fake, "consider-and-address");
        expect(summaryOf(finished)).toBe("address: Mentioned the change.");

        const [, consider, address] = fake.requests;
        expect(consider.sessionId).toBe(address.sessionId);
        expect(consider.cwd).toBe("/tmp/demo-worktrees/auto/issue-3");
        expect(consider.prompt).toContain("README.md:1: Mention the change.");
        expect(address.prompt).toContain("Address review 1");
        // Considering changes nothing on GitHub.
        expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
      }),
  );

  effect(
    "Review.recheck approves when only a point an approval made is open, whatever the reviewer answers",
    () =>
      Effect.gen(function* () {
        const fake = makeFake(["approve", "request-changes"], roles);
        fake.rechecked.findings = [
          { finding: "Fix the description", remediated: false, blocking: false },
        ];

        const finished = yield* runToEnd(fake, "recheck-verdict");
        expect(summaryOf(finished)).toBe("approve then approve");

        const [, recheck] = fake.requests;
        expect(recheck.prompt).toContain("approved it");
        expect(fake.submitted.map((review) => review.state)).toEqual(["APPROVED", "APPROVED"]);
      }),
  );

  effect("Review.recheck requests changes for a blocking finding left open", () =>
    Effect.gen(function* () {
      const fake = makeFake(["request-changes", "approve"], roles);
      fake.rechecked.findings = [
        { finding: "Mention the change", remediated: true, blocking: true },
        { finding: "A new bug", remediated: false, blocking: true },
      ];

      const finished = yield* runToEnd(fake, "recheck-verdict");
      expect(summaryOf(finished)).toBe("request-changes then request-changes");

      const [, recheck] = fake.requests;
      expect(recheck.prompt).toContain("asked for changes");
    }),
  );

  effect("Review.settledVerdict keeps the reviewer's verdict when it lists no findings", () =>
    Effect.sync(() => {
      expect(Review.settledVerdict([], "request-changes")).toBe("request-changes");
      expect(Review.settledVerdict([], "approve")).toBe("approve");
      // Saved before findings said whether they block: an open one blocks.
      expect(Review.settledVerdict([{ finding: "Old", remediated: false }], "approve")).toBe(
        "request-changes",
      );
    }),
  );

  effect(
    "Implement.addressFindings shows the author the description, and its answer replaces it between the Closes lines and the footer",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("request-changes");
        fake.pullText.body = [
          "Closes #3\nPart of #9",
          "The allowlist is in `daemon-commands.protocol.ts`.",
          "---\nOpened by Chernabog for an unattended run. A person merges.",
        ].join("\n\n");

        expect(summaryOf(yield* runToEnd(fake, "address"))).toBe("Mentioned the change.");

        const [, address] = fake.requests;
        expect(address.prompt).toContain("## The pull request's description");
        expect(address.prompt).toContain("`daemon-commands.protocol.ts`");
        expect(fake.pullText.body).toBe(
          [
            "Closes #3\nPart of #9",
            "The change.",
            "---\nOpened by Chernabog for an unattended run. A person merges.",
          ].join("\n\n"),
        );
      }),
  );

  effect("Implement.addressFindings leaves a description a person wrote alone", () =>
    Effect.gen(function* () {
      const fake = makeFake("request-changes");
      fake.pullText.body = "Written by a person.";

      expect((yield* runToEnd(fake, "address")).status).toBe("done");

      const [, address] = fake.requests;
      expect(address.prompt).not.toContain("## The pull request's description");
      expect(fake.pullText.body).toBe("Written by a person.");
    }),
  );

  effect("PullRequest.comment and Issue.comment post once each, and do nothing else", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect((yield* runToEnd(fake, "comments")).status).toBe("done");
      expect(fake.comments.map((comment) => comment.body)).toEqual([
        "On the pull request.",
        "On the issue.",
      ]);
      expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
    }),
  );
});

describe("PullRequest.merge", () => {
  const approved = (fake: Fake, sha = HEAD) => {
    fake.comment(reviewMarker.write({ sha, round: 1, verdict: "approve" }));
  };

  effect("merges exactly the reviewed head once checks are green and the review approved it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      approved(fake);
      const finished = yield* runToEnd(fake, "merge");
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  // A required check passing and an optional one failing on the head.
  const optionalFailing = (fake: Fake) => {
    approved(fake);
    fake.merge.checks = Option.some({
      headSha: HEAD,
      checks: [
        { name: "test", kind: "check-run", state: "passed", required: true, url: "" },
        { name: "ci/docs", kind: "status", state: "failed", required: false, url: "" },
      ],
      required: ["test"],
      caveat: Option.none(),
    });
  };

  effect("merges on its required checks while an optional one fails, when the flow says so", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      optionalFailing(fake);
      const finished = yield* runFlowToEnd(ignoringOptional, fake, item("merge"));
      expect(finished.status).toBe("done");
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  effect("holds the merge for a failing optional check by default", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      optionalFailing(fake);
      const finished = yield* runToEnd(fake, "merge");
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("checks failed: ci/docs");
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  // Each case sets up one reason to refuse, and the run hands the pull request to a person without merging.
  const refusals: ReadonlyArray<readonly [string, (fake: Fake) => void, string]> = [
    [
      "checks failed",
      (fake) => {
        approved(fake);
        fake.merge.ci = { state: "red", failedChecks: ["test"] };
      },
      "checks failed: test",
    ],
    [
      "checks pending",
      (fake) => {
        approved(fake);
        fake.merge.ci = { state: "pending", waitingOn: ["test"] };
      },
      "checks are still pending",
    ],
    ["no review", () => {}, "it has no review"],
    [
      "the head moved",
      (fake) => {
        approved(fake, "old5678abc");
      },
      "the head moved to `abc1234` since review 1 saw `old5678`",
    ],
    [
      "changes requested",
      (fake) => {
        fake.comment(reviewMarker.write({ sha: HEAD, round: 1, verdict: "request-changes" }));
      },
      "review 1 requested changes",
    ],
    [
      "a human-only path",
      (fake) => {
        approved(fake);
        fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];
      },
      "it touches paths a person must handle: `.github/workflows/ci.yml`",
    ],
    [
      "a layer of a stack",
      (fake) => {
        approved(fake);
        stackOn(fake, "auto/issue-2");
      },
      "stacked on auto/issue-2 (#2); it merges after the layer below",
    ],
    [
      "GitHub refuses",
      (fake) => {
        approved(fake);
        fake.merge.refusal = Option.some("GitHub refused the merge: Required approving review");
      },
      "GitHub refused the merge: Required approving review",
    ],
  ];

  for (const [name, arrange, reason] of refusals) {
    effect(`refuses, with the reason, on ${name}`, () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        arrange(fake);
        const finished = yield* runToEnd(fake, "merge");
        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain(`#${PULL} not merged: ${reason}`);

        if (name !== "GitHub refuses") {
          expect(fake.merge.requests).toEqual([]);
        }
      }),
    );
  }
});

describe("Implement.handOff", () => {
  effect(
    "asks one reviewer from the pool, never the author, and the same one when it runs again",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", { reviewers: ["chernabog-bot", "data-quail", "zach"] });
        fake.labelsOf(PULL).splice(0);
        expect((yield* runToEnd(fake, "hand-off")).status).toBe("done");
        expect(fake.people.requested).toHaveLength(1);
        expect(["data-quail", "zach"]).toContain(fake.people.requested[0]);
        expect(fake.labelsOf(PULL)).toEqual([]);
        expect(fake.labelsOf(ISSUE)).toEqual([]);
      }),
  );

  effect(
    "labels the pull request needs-review for a person without a pool, or with only its author in it",
    () =>
      Effect.gen(function* () {
        for (const overrides of [{}, { reviewers: ["chernabog-bot"] }]) {
          const fake = makeFake("approve", overrides);
          fake.labelsOf(PULL).splice(0);
          expect((yield* runToEnd(fake, "hand-off")).status).toBe("done");
          expect(fake.labelsOf(PULL)).toEqual([DEFAULT_LABELS.needsReview]);
          expect(fake.people.requested).toEqual([]);
        }
      }),
  );

  effect("asks for no review when the flow reviews the pull request itself", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.labelsOf(PULL).splice(0);
      expect((yield* runToEnd(fake, "hand-off-unlabelled")).status).toBe("done");
      expect(fake.labelsOf(PULL)).toEqual([]);
      expect(fake.people.requested).toEqual([]);
      expect(fake.labelsOf(ISSUE)).toEqual([]);
      expect(
        fake.comments
          .map((comment) => comment.body)
          .some((body) => body.includes("chernabog-session")),
      ).toBe(true);
    }),
  );
});

describe("Implement.push", () => {
  const implementing = flowHandle(repo, "implement", implement);

  effect(
    "hands an issue whose agent left its changes staged, with no commit, to a person, naming the files",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
        // The agent stages its work and answers before the commit lands.
        fake.author.leaves = ["M  src/a.ts", "A  test/a.test.ts"];

        const finished = yield* runFlowToEnd(
          implementing,
          fake,
          item(`issue-${ISSUE}`, { issue: ISSUE }),
        );

        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain(
          `the agent committed nothing on auto/issue-${ISSUE}, and left uncommitted: \`src/a.ts\`, \`test/a.test.ts\``,
        );
        expect(fake.git.pushes).toBe(0);
        expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      }),
  );
});
