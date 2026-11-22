// `chernabog progress backfill` (ADR 21, consequences; audit, fix-order step
// 7): a record for every open item with none, inferred from GitHub once, by
// the table in docs/run-progress/audit.md. One test per row, and the safety
// it promises: a dry run writes nothing, a second run writes nothing, a
// record a run wrote meanwhile wins, and an item the facts don't settle is
// listed for a person.

import {
  Backfill,
  Claims,
  DEFAULT_LABELS,
  Epic,
  Implement,
  Phases,
  Plan,
  planMarker,
  Progress,
  reviewMarker,
} from "@chernabog/sdk";
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

// A plan's tasks, as a marker kept them before records did, and the blob
// backfill carries them into.
const TASKS = [{ key: "a", title: "Do a", body: "", kind: "auto", blockedBy: [] }];
const BLOB = Plan.planBlob(TASKS);

// The text of the plan's blob the spec's record names.
const blobOf = (fake: Fake) =>
  onFake(
    fake,
    Effect.map(
      Progress.use((progress) => progress.blob(ISSUE_ITEM, BLOB.hash)),
      Option.map((bytes) => new TextDecoder().decode(bytes)),
    ),
  );

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
      // A person's answer is a comment after the plan's.
      expect(found[0]).toMatchObject({ data: { round: 2, after: 2 } });
    }),
  );

  effect("I2: the tasks a plan marker kept go into the record, as the blob it names", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.setLabels(ISSUE, [Plan.LABELS.proposed]);
      comment(fake, ME, planMarker.write({ round: 1, plan: TASKS }));

      yield* backfill(fake);

      const record = fake.records().get(ISSUE_ITEM);
      expect(record).toMatchObject({
        phase: Phases.PHASES.issue.proposed,
        data: Option.some({ round: 1, after: 1, plan: BLOB.hash }),
        blobs: [BLOB.hash],
      });
      expect(yield* blobOf(fake)).toEqual(Option.some(BLOB.text));
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

  // A review marker, as review.round wrote one before records kept the review (#564).
  const marked = (fake: Fake, sha = HEAD) => {
    comment(fake, ME, reviewMarker.write({ sha, round: 2, verdict: "approve", sessionId: "s1" }));
  };

  effect("copies the review its comment's marker names into a reviewed pull request's record", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.mergeHeld, { data: { key: "pr-7" } });
      comment(fake, PERSON, reviewMarker.write({ sha: "person99", round: 9, verdict: "approve" }));
      marked(fake);

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([
        writes(PR_ITEM, Phases.PHASES.pullRequest.mergeHeld),
      ]);

      const written = yield* backfill(fake);

      expect(written.map((each) => each.written)).toEqual([true]);
      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: Phases.PHASES.pullRequest.mergeHeld,
        by: Backfill.WRITER,
        from: Option.some(Phases.PHASES.pullRequest.mergeHeld),
        data: Option.some({
          key: "pr-7",
          review: { sha: HEAD, round: 2, verdict: "approve", reviewer: ME, sessionId: "s1" },
        }),
      });
      expect(yield* survey(fake)).toEqual([]);
    }),
  );

  effect("leaves a record that keeps a review, or a pull request with no marker, alone", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordReview({ sha: "new5678", round: 3, verdict: "approve" });
      marked(fake);
      expect(yield* survey(fake)).toEqual([]);

      const bare = fresh();
      bare.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.approved);
      expect(yield* survey(bare)).toEqual([]);
    }),
  );

  effect(
    "writes the marker's review with the phase of a reviewed pull request with no record",
    () =>
      Effect.gen(function* () {
        const fake = fresh();
        fake.submitted.push(review(ME, "APPROVED"));
        marked(fake);

        yield* backfill(fake);

        expect(fake.records().get(PR_ITEM)).toMatchObject({
          phase: Phases.PHASES.pullRequest.approved,
          from: Option.none(),
          data: Option.some({ review: { sha: HEAD, round: 2, reviewer: ME } }),
        });
      }),
  );

  effect("I3: carries the plan a spec's marker kept into a proposed record that names none", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(ISSUE_ITEM, Phases.PHASES.issue.proposed, {
        data: { round: 2, since: "2026-11-01T00:00:00.000Z", within: "14 days" },
      });
      comment(fake, ME, planMarker.write({ round: 1, plan: [] }));
      comment(fake, ME, planMarker.write({ round: 2, plan: TASKS }));

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([
        writes(ISSUE_ITEM, Phases.PHASES.issue.proposed),
      ]);

      const written = yield* backfill(fake);

      expect(
        written.filter((each) => each.finding.item === ISSUE_ITEM).map((each) => each.written),
      ).toEqual([true]);
      expect(fake.records().get(ISSUE_ITEM)).toMatchObject({
        by: Backfill.WRITER,
        from: Option.some(Phases.PHASES.issue.proposed),
        data: Option.some({
          round: 2,
          since: "2026-11-01T00:00:00.000Z",
          within: "14 days",
          after: 2,
          plan: BLOB.hash,
        }),
      });
      expect(yield* blobOf(fake)).toEqual(Option.some(BLOB.text));
      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([]);
    }),
  );

  effect("I3: leaves a proposed record alone when no marker of its round kept tasks", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(ISSUE_ITEM, Phases.PHASES.issue.proposed, { data: { round: 2 } });
      comment(fake, ME, planMarker.write({ round: 1, plan: TASKS }));
      comment(fake, ME, planMarker.write({ round: 2 }));

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([]);
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

// Before every park site had a phase of its own (#566), implement's wait on
// an adopted pull request's CI parked on the issue's awaiting-ci, as its wait
// on one it opened does, and address-review's wait on its fix's CI parked on
// the pull request's awaiting-ci. Backfill moves a parked item from the old
// shared phase onto its site's own, keeping the round and the data.
describe("progress backfill's park phases", () => {
  const SINCE = "2026-11-01T00:00:00.000Z";

  effect("a pull request parked on awaiting-ci moves to awaiting-fix-ci, in its round", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(PR_ITEM, "awaiting-ci-2", { data: { since: SINCE } });

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([writes(PR_ITEM, "awaiting-fix-ci-2")]);

      const written = yield* backfill(fake);

      expect(written.map((each) => each.written)).toEqual([true]);
      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: "awaiting-fix-ci-2",
        from: Option.some("awaiting-ci-2"),
        by: Backfill.WRITER,
        data: Option.some({ since: SINCE }),
      });
      expect(yield* survey(fake)).toEqual([]);
    }),
  );

  effect("an issue parked on an adopted pull request's CI moves to awaiting-adopted-ci", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(ISSUE_ITEM, "awaiting-ci", { data: { pullRequest: PULL, since: SINCE } });

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([
        writes(ISSUE_ITEM, Phases.PHASES.issue.awaitingAdoptedCi),
      ]);

      yield* backfill(fake);

      expect(fake.records().get(ISSUE_ITEM)).toMatchObject({
        phase: Phases.PHASES.issue.awaitingAdoptedCi,
        data: Option.some({ pullRequest: PULL, since: SINCE }),
      });
    }),
  );

  effect("an issue parked on the CI of the pull request its run opened stays", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(ISSUE_ITEM, "awaiting-ci-2", { data: { since: SINCE } });

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([]);
    }),
  );

  effect("a document's park from before #567 keeps its phase, with only its facts", () =>
    Effect.gen(function* () {
      const fake = fresh();
      const resume = { flow: "implement", node: "ci", login: ME, kept: { opened: {} } };

      fake.recordPhase(ISSUE_ITEM, "awaiting-ci", {
        data: { pullRequest: PULL, since: SINCE, resume },
      });

      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([
        writes(ISSUE_ITEM, Phases.PHASES.issue.awaitingCi),
      ]);

      yield* backfill(fake);

      // As the recipe parks it: the pull request is the one on the issue's branch.
      expect(fake.records().get(ISSUE_ITEM)).toMatchObject({
        phase: Phases.PHASES.issue.awaitingCi,
        data: Option.some({ since: SINCE }),
      });
      expect(saidOn(ISSUE_ITEM, yield* survey(fake))).toEqual([]);
    }),
  );

  effect("a document's merge hold from before #567 names the flow that holds it", () =>
    Effect.gen(function* () {
      const fake = fresh();
      const resume = { flow: "re-review", node: "landed", login: ME, kept: {} };

      fake.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.mergeHeld, {
        data: { pullRequest: PULL, key: `${PR_ITEM}-again`, resume },
      });

      yield* backfill(fake);

      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: Phases.PHASES.pullRequest.mergeHeld,
        data: Option.some({ pullRequest: PULL, key: `${PR_ITEM}-again`, flow: "re-review" }),
      });
    }),
  );

  effect("a pull request's document park on the shared phase moves without where it resumed", () =>
    Effect.gen(function* () {
      const fake = fresh();
      const resume = { flow: "address-review", node: "ci", login: ME, kept: {} };
      fake.recordPhase(PR_ITEM, "awaiting-ci", {
        data: { pullRequest: PULL, since: SINCE, resume },
      });

      expect(saidOn(PR_ITEM, yield* survey(fake))).toEqual([writes(PR_ITEM, "awaiting-fix-ci")]);

      yield* backfill(fake);

      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: "awaiting-fix-ci",
        data: Option.some({ pullRequest: PULL, since: SINCE }),
      });
    }),
  );

  effect("a record a run moved after the survey keeps the run's", () =>
    Effect.gen(function* () {
      const fake = fresh();
      fake.recordPhase(PR_ITEM, "awaiting-ci", { data: { since: SINCE } });

      const findings = yield* survey(fake);
      fake.recordPhase(PR_ITEM, Phases.PHASES.pullRequest.changesAsked);

      const written = yield* onFake(fake, Backfill.apply(findings));

      expect(written.map((each) => each.written)).toEqual([false]);
      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: Phases.PHASES.pullRequest.changesAsked,
      });
    }),
  );
});
