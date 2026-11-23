// The implement recipe on an issue an open pull request already closes,
// against an in-memory GitHub: it adopts that pull request rather than
// implementing the issue again, waits for a draft to be marked ready, and
// hands the issue to a person when it can't adopt one.

import {
  claimMarker,
  DEFAULT_LABELS,
  defineFlow,
  Implement,
  type Json,
  Phases,
  Review,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import implement from "../packages/recipes/flows/implement.ts";
import resolveConflicts from "../packages/recipes/flows/resolve-conflicts.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  deliverSignals,
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
  triggered,
} from "./sdk-fakes.ts";

const implementing = flowHandle(repo, "implement", implement);
const work = item(`issue-${ISSUE}`, { issue: ISSUE });
const POOL = { reviewers: ["zach", "data-quail"] };
const BRANCH = "zach/fix-it";
const PR_ITEM = Phases.pullRequestItem(PULL);
const PULL_URL = `https://github.com/dataquail/demo/pull/${PULL}`;

// An open pull request that closes the issue, as GitHub's GraphQL API gives it.
const closingPull = (overrides: Record<string, Json> = {}): Json => ({
  number: PULL,
  url: PULL_URL,
  state: "OPEN",
  isDraft: false,
  headRefName: BRANCH,
  baseRefName: "main",
  isCrossRepository: false,
  ...overrides,
});

// The issue is queued, and a person already opened a pull request that closes it.
const queuedWithPull = (draft = false) => {
  const fake = makeFake("approve", POOL);
  fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
  fake.setLabels(PULL, []);
  fake.git.opened = true;
  fake.authored.headRef = BRANCH;
  fake.authored.author = "zach";
  fake.authored.draft = draft;
  fake.closing.push(closingPull({ isDraft: draft }));

  return fake;
};

const adoptions = (fake: Fake) =>
  fake.comments.flatMap((comment) =>
    Option.toArray(
      Option.flatMap(claimMarker.read(comment.body), (claim) =>
        Option.fromUndefinedOr(claim.adopted),
      ),
    ),
  );

// The persona's pull request flows that would push to it: what each would start on.
const pushersFind = (fake: Fake) =>
  Effect.gen(function* () {
    const answering = yield* flowTriggered(fake, addressReview);
    const resolving = yield* flowTriggered(fake, resolveConflicts);

    return [...answering, ...resolving].map((found) => found.key);
  });

// A review asks for changes on the head, and the head conflicts with its base.
const wantedChanged = (fake: Fake) => {
  fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
  fake.merge.state = "dirty";
};

const saying = (fake: Fake, text: string) =>
  fake.comments.filter((comment) => comment.body.includes(text));

describe("an issue an open pull request already closes", () => {
  effect(
    "is adopted: no agent implements it, no branch or second pull request is made, and its pull request goes for review",
    () =>
      Effect.gen(function* () {
        const fake = queuedWithPull();
        const finished = yield* runToEnd(implementing, fake, work);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(`#${ISSUE}: ${PULL_URL} is ready for review`);

        expect(fake.requests).toEqual([]);
        expect(fake.based.createdFrom).toEqual([]);
        expect(fake.based.targets).toEqual([]);

        // The claim marker records the adoption, and the issue says which pull request.
        expect(adoptions(fake)).toEqual([{ number: PULL, url: PULL_URL, draft: false }]);
        expect(saying(fake, `Adopted #${PULL}`)).toHaveLength(1);
        expect(finished.subjects).toEqual([`pr-${PULL}`]);

        // Marked as this persona's to answer reviews on, and sent for review by someone other than its author.
        expect(fake.labelsOf(PULL)).toContain(Implement.ADOPTED_LABEL);
        expect(fake.people.pullAssigned).toEqual([fake.people.me]);
        expect(fake.people.requested).toEqual(["data-quail"]);
        expect(fake.labelsOf(ISSUE)).toEqual([]);

        // address-review finds the session in the issue's record, naming the adopted branch.
        const session = Phases.authorOf(fake.records(), PULL);

        expect(Option.map(session, (marker) => marker.branch)).toEqual(Option.some(BRANCH));
      }),
  );

  effect(
    "whose CI fails is fixed in a worktree on that pull request's branch, made only then",
    () =>
      Effect.gen(function* () {
        const fake = queuedWithPull();
        fake.merge.ci = { state: "red", failedChecks: ["test"] };
        const finished = yield* runToEnd(implementing, fake, work);
        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain("CI is still red");

        expect(fake.requests[0]?.cwd).toBe(`/tmp/demo-worktrees/${BRANCH}`);
        expect(fake.requests[0]?.prompt).toContain(`CI failed on pull request #${PULL}: test.`);
        expect(fake.requests[0]?.prompt).toContain(`--branch ${BRANCH}`);
        // A failing title check is fixed on the pull request: an answer's title isn't applied again.
        expect(fake.requests[0]?.prompt).toContain(`gh pr edit ${PULL} --title`);
        expect(fake.git.pushes).toBeGreaterThan(0);
      }),
  );

  effect(
    "records, at its hand-off, who had reviewed it already, so their review asked again is a re-review",
    () =>
      Effect.gen(function* () {
        const fake = queuedWithPull();
        fake.submitted.push({ author: "data-quail", state: "COMMENTED", commitSha: HEAD });

        const finished = yield* runToEnd(implementing, fake, work);
        expect(finished.status).toBe("done");
        expect(fake.records().get(`pr-${PULL}`)).toMatchObject({
          phase: "review-asked",
          data: Option.some({ reviewed: ["data-quail"] }),
        });
      }),
  );

  effect("records no reviewers at the hand-off of one nobody has reviewed, only its adoption", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();

      yield* runToEnd(implementing, fake, work);
      expect(fake.records().get(`pr-${PULL}`)).toMatchObject({
        phase: "review-asked",
        data: Option.some({ adopted: true }),
      });
    }),
  );

  effect("on the run's own branch is not adopted: the run goes on with the work as before", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      fake.closing.push(closingPull({ headRefName: `auto/issue-${ISSUE}` }));
      const finished = yield* runToEnd(implementing, fake, work);
      expect(finished.status).toBe("done");
      expect(fake.requests).toHaveLength(1);
      expect(adoptions(fake)).toEqual([]);
    }),
  );

  effect(
    "that is a draft is adopted, but goes for review only once its author marks it ready",
    () =>
      Effect.gen(function* () {
        const fake = queuedWithPull(true);
        let parked = false;

        const finished = yield* runUntil(implementing, fake, work, (run) =>
          Effect.gen(function* () {
            if (run.status !== "running") {
              return true;
            }

            const { waits } = yield* listRunWaitsHandler({ runId: run.id, signal: "ready" });

            if (!waits.some((wait) => wait.deferred === `ready:draft-${PULL}`)) {
              return false;
            }

            if (!parked) {
              parked = true;
              // Waiting, it has asked nobody to review the draft.
              expect(fake.people.requested).toEqual([]);
              expect(adoptions(fake)).toEqual([{ number: PULL, url: PULL_URL, draft: true }]);
              // Still a draft: nothing wakes it.
              expect(yield* triggered(fake, Implement.readied).pipe(Effect.orDie)).toEqual([]);
              expect(fake.labelsOf(ISSUE)).toContain(Implement.AWAITING_READY_LABEL);
              // The draft is its author's: until hand-off, it isn't the persona's to push to.
              expect(fake.labelsOf(PULL)).toEqual([]);
              expect(fake.people.pullAssigned).toEqual([]);
              expect(yield* onFake(fake, Review.authoredByMe).pipe(Effect.orDie)).toEqual([]);
              fake.authored.draft = false;
            }

            // Work a run may start, not only a wake: a CI job that parked
            // here has ended. On this daemon the parked run holds the issue,
            // so the signal wakes it and nothing new starts.
            const readied = yield* triggered(fake, Implement.readied).pipe(Effect.orDie);
            expect(
              readied.map((found) => [found.key, found.signals, found.wakeOnly === true]),
            ).toEqual([[`issue-${ISSUE}`, ["ready"], false]]);
            yield* deliverSignals(implementing, IMPLICIT, readied);

            return false;
          }),
        );

        expect(parked).toBe(true);
        expect(finished.status).toBe("done");
        expect(fake.people.requested).toEqual(["data-quail"]);
        expect(fake.requests).toEqual([]);
        expect(fake.labelsOf(ISSUE)).not.toContain(Implement.AWAITING_READY_LABEL);
      }),
  );

  effect(
    "is no other flow's to push to until hand-off, even with changes asked for and a conflict",
    () =>
      Effect.gen(function* () {
        const fake = queuedWithPull();
        wantedChanged(fake);
        // Red CI keeps the run on the pull request, and ends it short of hand-off.
        fake.merge.ci = { state: "red", failedChecks: ["test"] };
        expect((yield* runToEnd(implementing, fake, work)).status).toBe("needs-human");
        expect(fake.labelsOf(PULL)).not.toContain(Implement.ADOPTED_LABEL);
        expect(fake.people.pullAssigned).toEqual([]);
        expect(yield* pushersFind(fake)).toEqual([]);

        // Handed off, it is the persona's: both flows take it on.
        const handed = queuedWithPull();
        expect((yield* runToEnd(implementing, handed, work)).status).toBe("done");
        handed.people.requested = [];
        wantedChanged(handed);
        expect(yield* pushersFind(handed)).toEqual([
          // The hand-off recorded its phases, which the person's review then moved on.
          `pr-${PULL}-changes-asked-v3`,
          `pr-${PULL}-${HEAD.slice(0, 7)}`,
        ]);
      }),
  );

  effect("the recipe's trigger wakes a run waiting on a draft once it is marked ready", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull(true);
      // The record says the run waits; the label is only for people, and a
      // person who took it off leaves the run to be woken as before.
      fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
      fake.recordPhase(`issue-${ISSUE}`, "awaiting-ready", {
        data: {
          pullRequest: PULL,
          withinMillis: 14 * 24 * 60 * 60 * 1000,
          since: DateTime.formatIso(yield* DateTime.now),
        },
      });
      expect(yield* flowTriggered(fake, implement)).toEqual([]);

      fake.authored.draft = false;
      expect(
        (yield* flowTriggered(fake, implement)).map((found) => [found.key, found.signals]),
      ).toEqual([[`issue-${ISSUE}`, ["ready"]]]);
    }),
  );

  effect("goes to a person, naming them, when several close it", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();
      fake.closing.push(
        closingPull({
          number: 8,
          url: "https://github.com/dataquail/demo/pull/8",
          headRefName: "other",
        }),
      );
      const finished = yield* runToEnd(implementing, fake, work);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain(`#${PULL}`);
      expect(summaryOf(finished)).toContain("#8");

      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.phases()[Phases.issueItem(ISSUE)]).toBe("with-person");
      const said = saying(fake, "already close this issue");
      expect(said).toHaveLength(1);
      expect(said[0]?.body).toContain(PULL_URL);
      expect(said[0]?.body).toContain("https://github.com/dataquail/demo/pull/8");
      expect(fake.requests).toEqual([]);
      expect(fake.based.createdFrom).toEqual([]);
      expect(adoptions(fake)).toEqual([]);
    }),
  );

  effect("goes to a person when the one that closes it is on a fork it can't push to", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();
      fake.closing.splice(0, 1, closingPull({ isCrossRepository: true }));
      const finished = yield* runToEnd(implementing, fake, work);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("fork");

      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.phases()[Phases.issueItem(ISSUE)]).toBe("with-person");
      expect(saying(fake, PULL_URL)).toHaveLength(1);
      expect(fake.requests).toEqual([]);
      expect(fake.labelsOf(PULL)).toEqual([]);
    }),
  );
});

const consider = defineFlow({
  trigger: Effect.succeed([]),
  workflow: () =>
    Implement.considerFindings(
      PULL,
      { verdict: "request-changes", sha: "abc1234def", summary: "Rename it." },
      Implement.thisRunsSession,
    ).pipe(
      Effect.map((decision) => decision.status),
      Effect.orDie,
    ),
});

// The pull request's record, saying chernabog adopted it: what makes an
// adopted pull request chernabog's (audit R1, R2), not its auto:adopted label.
const adoptedRecord = (fake: Fake) => {
  fake.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.reviewAsked, { data: { adopted: true } });
};

describe("an adopted pull request", () => {
  effect("is one address-review and resolve-conflicts take as the persona's own", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();
      expect(yield* onFake(fake, Review.authoredByMe)).toEqual([]);

      // Its record says adopted, but another persona has it: still not this one's.
      adoptedRecord(fake);
      expect(yield* onFake(fake, Review.authoredByMe)).toEqual([]);

      fake.people.pullAssigned = [fake.people.me];
      expect((yield* onFake(fake, Review.authoredByMe)).map((pull) => pull.number)).toEqual([PULL]);
    }),
  );

  effect("auto:adopted added by hand, with no record saying so, makes it nobody's", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();
      fake.people.pullAssigned = [fake.people.me];
      fake.setLabels(PULL, [Implement.ADOPTED_LABEL]);

      expect(yield* onFake(fake, Review.authoredByMe)).toEqual([]);
    }),
  );

  effect("auto:adopted taken off by hand leaves it the persona's, by its record", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();
      fake.people.pullAssigned = [fake.people.me];
      adoptedRecord(fake);
      fake.setLabels(PULL, []);

      expect((yield* onFake(fake, Review.authoredByMe)).map((pull) => pull.number)).toEqual([PULL]);
    }),
  );

  effect("gives a new author session the pull request's history before the review", () =>
    Effect.gen(function* () {
      const fake = queuedWithPull();
      adoptedRecord(fake);
      const finished = yield* runToEnd(flowHandle(repo, "consider", consider), fake, item("pr"));
      expect(finished.status).toBe("done");

      expect(fake.requests[0]?.prompt).toContain(`gh pr diff ${PULL}`);
      expect(fake.requests[0]?.prompt).toContain("Rename it.");
      // A session that exists already has the history.
      const resumed = fake.requests.map((asked) => Option.getOrElse(asked.resumePrompt, () => ""));
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toContain("Rename it.");
      expect(resumed[0]).not.toContain(`gh pr diff ${PULL}`);
    }),
  );
});
