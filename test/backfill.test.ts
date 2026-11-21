// `chernabog progress backfill` (ADR 21, consequences; audit, fix-order step
// 7): a record for every open item with none, inferred from GitHub once, by
// the table in docs/run-progress/audit.md. One test per row, and the safety
// it promises: a dry run writes nothing, a second run writes nothing, a
// record a run wrote meanwhile wins, and an item the facts don't settle is
// listed for a person.

import { Backfill, Claims, DEFAULT_LABELS, Epic, Implement, Phases, Plan } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "./effect-test.ts";
import { EARLIER_RUN } from "./progress-fake.ts";
import { type Fake, HEAD, ISSUE, makeFake, onFake, PULL } from "./sdk-fakes.ts";

const PR_ITEM = Phases.pullRequestItem(PULL);
const ISSUE_ITEM = Phases.issueItem(ISSUE);
const EPIC_ITEM = Claims.epic(ISSUE);
const ME = "chernabog-bot";
const PERSON = "a-person";

// A fake whose pull request is an agent's (auto/issue-3), open, asking
// nobody for a review; and whose issue is in progress, with no record.
const fresh = () => makeFake("approve");

// As the repo's personas, by its committed config: the fake's, ME.
const survey = (fake: Fake) => onFake(fake, Backfill.survey);

// What backfill writes: the survey, then each finding written.
const backfill = (fake: Fake) =>
  Effect.gen(function* () {
    const findings = yield* survey(fake);

    return yield* onFake(fake, Backfill.apply(findings));
  });

const review = (author: string, state: string, commitSha = HEAD) => ({
  author,
  state,
  commitSha,
});

const comment = (fake: Fake, author: string, body: string) => {
  fake.comments.push({
    id: fake.comments.length + 1,
    author,
    body,
    createdAt: "2026-11-01T00:00:00Z",
    trusted: true,
  });
};

// A finding without the facts it read: the phase to write, or a person.
type Said = { readonly kind: string; readonly item: string; readonly phase?: string };

const saidOf = (finding: Backfill.Finding): Said => {
  if (finding.kind === "person") {
    return { kind: finding.kind, item: finding.item };
  }

  return { kind: finding.kind, item: finding.item, phase: finding.phase };
};

// The findings on `item`, as the survey reports them.
const findingOn = (item: string, found: ReadonlyArray<Backfill.Finding>) =>
  found.filter((finding) => finding.item === item);

// What the survey says of `item`.
const saidOn = (item: string, found: ReadonlyArray<Backfill.Finding>) =>
  findingOn(item, found).map(saidOf);

const writes = (item: string, phase: string): Said => ({ kind: "write", item, phase });

const forPerson = (item: string): Said => ({ kind: "person", item });

describe("progress backfill's pull requests", () => {
  effect("P1: every asked reviewer reviewed before, so it is asked again", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.submitted.push(review(ME, "CHANGES_REQUESTED", "old1234"));
      fake.people.requested = [ME];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.reviewAskedAgain),
      ]);
    }),
  );

  effect("P1: a review that only commented counts as reviewed, as the count did", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.submitted.push(review(ME, "COMMENTED"));
      fake.people.requested = [ME];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.reviewAskedAgain),
      ]);
    }),
  );

  effect("P2: asked reviewers who haven't reviewed, and no decisive review: review asked", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.people.requested = [ME];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.reviewAsked),
      ]);
    }),
  );

  effect("P3: some asked reviewers reviewed before and some didn't: for a person", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.submitted.push(review(ME, "APPROVED"));
      fake.people.requested = [ME, PERSON];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([forPerson(PR_ITEM)]);
    }),
  );

  effect("P3: a first review asked after another reviewer's decisive one: for a person", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.submitted.push(review(PERSON, "CHANGES_REQUESTED"));
      fake.people.requested = [ME];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([forPerson(PR_ITEM)]);
    }),
  );

  effect("P4: a shipping pull request approved on its head that a run holds the merge of", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(PULL, [DEFAULT_LABELS.ship]);
      fake.submitted.push(review(ME, "APPROVED"));
      comment(
        fake,
        ME,
        'Holding the merge. <!-- chernabog-merge-hold {"runId":"r1","key":"pr-7"} -->',
      );

      const found = findingOn(PR_ITEM, yield* survey(fake));

      expect(found.map(saidOf)).toEqual([writes(PR_ITEM, Phases.PHASES.pullRequest.mergeHeld)]);
      expect(found[0]).toMatchObject({ data: { key: "pr-7" } });
    }),
  );

  effect("P5: hold markers of two work items: for a person", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(PULL, [DEFAULT_LABELS.ship]);
      fake.submitted.push(review(ME, "APPROVED"));
      comment(fake, ME, '<!-- chernabog-merge-hold {"runId":"r1","key":"pr-7"} -->');
      comment(fake, ME, '<!-- chernabog-merge-hold {"runId":"r2","key":"pr-7-review-2"} -->');

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([forPerson(PR_ITEM)]);
    }),
  );

  effect("P5: a hold marker on a pull request whose head isn't approved: for a person", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(PULL, [DEFAULT_LABELS.ship]);
      fake.submitted.push(review(ME, "APPROVED", "old1234"));
      comment(fake, ME, '<!-- chernabog-merge-hold {"runId":"r1","key":"pr-7"} -->');

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([forPerson(PR_ITEM)]);
    }),
  );

  effect("one handed to a person is with-person, whatever a hold marker says", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(PULL, [DEFAULT_LABELS.ship, DEFAULT_LABELS.needsHuman]);
      fake.submitted.push(review(ME, "APPROVED"));
      comment(fake, ME, '<!-- chernabog-merge-hold {"runId":"r1","key":"pr-7"} -->');

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.withPerson),
      ]);
    }),
  );

  effect("P6: changes asked on the head, or before a push since: changes asked", () =>
    Effect.gen(function* () {
      const onHead = fresh();
      onHead.submitted.push(review(ME, "APPROVED", "old1234"), review(ME, "CHANGES_REQUESTED"));

      const pushedSince = fresh();
      pushedSince.submitted.push(review(ME, "CHANGES_REQUESTED", "old1234"));

      for (const fake of [onHead, pushedSince]) {
        expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
          writes(PR_ITEM, Phases.PHASES.pullRequest.changesAsked),
        ]);
      }
    }),
  );

  effect("P7: approved, with no hold: approved", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.submitted.push(review(ME, "COMMENTED"), review(ME, "APPROVED"));

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.approved),
      ]);
    }),
  );

  effect("P8: an agent's draft nobody was asked to review: draft", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.authored.draft = true;

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.draft),
      ]);
    }),
  );

  effect("P9: an agent's ready pull request with no review asked or given: for a person", () =>
    Effect.gen(function* () {
      expect(saidOn(PR_ITEM, yield* survey(fresh()))).toEqual([forPerson(PR_ITEM)]);
    }),
  );

  effect("a person's pull request no persona is asked to review or has reviewed is left out", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.authored.headRef = "feature/mine";
      fake.authored.author = PERSON;
      fake.people.requested = [PERSON];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([]);

      fake.people.requested = [ME];

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.reviewAsked),
      ]);
    }),
  );
});

describe("progress backfill's issues and epics", () => {
  effect("I1: waiting on the adopted draft its claim marker names: awaiting-ready with it", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(ISSUE, [Implement.AWAITING_READY_LABEL]);
      comment(
        fake,
        ME,
        `<!-- chernabog-claim {"runId":"r1","claimedAt":"2026-11-01T00:00:00Z","branch":"mine","ref":true,"adopted":{"number":${PULL},"url":"u","draft":true}} -->`,
      );

      const found = findingOn(ISSUE_ITEM, yield* survey(fake));

      expect(found.map(saidOf)).toEqual([writes(ISSUE_ITEM, Phases.PHASES.issue.awaitingReady)]);
      expect(found[0]).toMatchObject({
        data: { pullRequest: PULL, withinMillis: 14 * 24 * 60 * 60 * 1000 },
      });
    }),
  );

  effect(
    "I1: labelled awaiting-ready with no adopted draft in its claim marker: for a person",
    () =>
      Effect.gen(function* () {
        const fake = fresh();
        fake.setLabels(ISSUE, [Implement.AWAITING_READY_LABEL]);

        expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([forPerson(ISSUE_ITEM)]);
      }),
  );

  effect("I2: a posted plan waiting on a person: proposed, with the plan's round", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(ISSUE, [Plan.LABELS.proposed]);
      comment(fake, ME, '<!-- chernabog-plan {"round":1} -->');
      comment(fake, ME, '<!-- chernabog-plan {"round":2} -->');

      const found = findingOn(ISSUE_ITEM, yield* survey(fake));

      expect(found.map(saidOf)).toEqual([writes(ISSUE_ITEM, Phases.PHASES.issue.proposed)]);
      expect(found[0]).toMatchObject({ data: { round: 2 } });
    }),
  );

  effect("I2: labelled plan-proposed with no plan posted: for a person", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(ISSUE, [Plan.LABELS.proposed]);

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([forPerson(ISSUE_ITEM)]);
    }),
  );

  effect("a queued or in-progress issue needs no record: its lack of one is its phase", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([]);
    }),
  );

  effect(
    "E1: an epic a run posted its status on, with a task open: waiting, by its fingerprint",
    () =>
      Effect.gen(function* () {
        const fake = fresh();
        fake.setLabels(ISSUE, [Plan.LABELS.epic]);
        fake.graph.made.set(50, {
          number: 50,
          title: "a task",
          body: "",
          url: "u",
          createdAt: "2026-11-01T00:00:00Z",
          labels: [],
          assignees: [],
          state: "open",
        });
        fake.graph.subIssues.set(ISSUE, [50]);
        comment(fake, ME, `Status ${Epic.statusMarker.write({ fingerprint: "f1" })}`);

        const found = findingOn(EPIC_ITEM, yield* survey(fake));

        expect(found.map(saidOf)).toEqual([writes(EPIC_ITEM, Phases.PHASES.epic.waiting)]);
        expect(found[0]).toMatchObject({
          data: {
            fingerprint: "f1",
            tasks: { attempts: [], handedBack: [], withPerson: [] },
          },
        });
      }),
  );

  effect("E1: an epic no run posted on, or with no task open, needs no record", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(ISSUE, [Plan.LABELS.epic]);
      comment(fake, ME, `Status ${Epic.statusMarker.write({ fingerprint: "f1" })}`);

      expect(saidOn(EPIC_ITEM, yield* survey(fake))).toEqual([]);
    }),
  );
});

describe("progress backfill's writing", () => {
  effect("a dry run, the survey alone, writes nothing", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.people.requested = [ME];

      expect(yield* survey(fake)).not.toEqual([]);
      expect(fake.records().size).toBe(0);
    }),
  );

  effect("writes each finding from no record, as observer:backfill, with its data", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(PULL, [DEFAULT_LABELS.ship]);
      fake.submitted.push(review(ME, "APPROVED"));
      comment(fake, ME, '<!-- chernabog-merge-hold {"runId":"r1","key":"pr-7"} -->');

      const written = yield* backfill(fake);

      expect(written.map((each) => each.written)).toEqual([true]);
      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: Phases.PHASES.pullRequest.mergeHeld,
        by: Backfill.WRITER,
        from: Option.none(),
        data: Option.some({ key: "pr-7" }),
      });
    }),
  );

  effect("a second run writes nothing", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.people.requested = [ME];

      yield* backfill(fake);
      const before = fake.records().get(PR_ITEM);

      expect(yield* survey(fake)).toEqual([]);
      expect(yield* backfill(fake)).toEqual([]);
      expect(fake.records().get(PR_ITEM)).toBe(before);
    }),
  );

  effect("an item a run recorded after the survey keeps the run's record", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.people.requested = [ME];

      const findings = yield* survey(fake);
      fake.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.changesAsked);

      const written = yield* onFake(fake, Backfill.apply(findings));

      expect(written.map((each) => each.written)).toEqual([false]);
      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: Phases.PHASES.pullRequest.changesAsked,
        by: EARLIER_RUN,
      });
    }),
  );

  effect("an item the facts don't settle is listed, and nothing is written for it", () =>
    Effect.gen(function* () {
      const fake = fresh();

      const findings = yield* survey(fake);
      const written = yield* onFake(fake, Backfill.apply(findings));

      expect(findings.map(saidOf)).toEqual([forPerson(PR_ITEM)]);
      expect(written).toEqual([]);
      expect(fake.records().size).toBe(0);
    }),
  );

  effect("an item that holds a record is not surveyed", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.approved);

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([]);
    }),
  );
});
