// "With a person" is a ledger phase (ADR 21, decision 1): every hand-off to a
// person records with-person {why, from}, and auto:needs-human is that
// record's projection. A trusted person taking the label off is intent,
// which observer:handed-back records: the phase the item went to the person
// from again, or handed-back when it had none; anyone else's removal changes
// nothing. Backfill gives every labelled item its with-person record.

import {
  activity,
  type FlowError,
  type Json,
  type PhaseRecord,
  type WorkflowServices,
} from "@chernabog/core";
import {
  Backfill,
  Blocks,
  Claims,
  DEFAULT_LABELS,
  defineFlow,
  Implement,
  Ledger,
  Phases,
  Plan,
  PullRequest,
  Stack,
  StatusLabels,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import addressReview from "../packages/recipes/flows/address-review.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import review from "../packages/recipes/flows/review.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { EARLIER_RUN } from "./progress-fake.ts";
import {
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
} from "./sdk-fakes.ts";

const ISSUE_ITEM = Phases.issueItem(ISSUE);
const PR_ITEM = Phases.pullRequestItem(PULL);
const WITH_PERSON = "with-person";
const HANDED_BACK = "handed-back";
const PERSON = "a-maintainer";
const STRANGER = "a-stranger";

// A run of a flow whose workflow is `step`, its failures the run's.
const runStep = <A>(fake: Fake, step: Effect.Effect<A, FlowError, WorkflowServices>) =>
  runToEnd(
    flowHandle(
      repo,
      "hand-off",
      defineFlow({
        trigger: Effect.succeed([]),
        workflow: () => step.pipe(Effect.as("done")),
      }),
    ),
    fake,
    item("issue"),
  );

const recordOf = (fake: Fake, name: string) => Option.fromUndefinedOr(fake.records().get(name));

const dataOf = (fake: Fake, name: string) =>
  Option.flatMap(recordOf(fake, name), (found) => found.data);

// What `name`'s with-person record says: why, and the phase it left.
const withPersonOf = (fake: Fake, name: string) =>
  Option.flatMap(dataOf(fake, name), Schema.decodeUnknownOption(Phases.WithPerson));

const said = (why: string, from?: string) =>
  Option.some({ why, from: Option.fromUndefinedOr(from) });

const HandedBackData = Schema.Struct({ from: Schema.OptionFromNullOr(Schema.String) });

// The phase a handed-back record says the item went to a person from.
const handedBackFrom = (fake: Fake, name: string) =>
  Option.map(
    Option.flatMap(dataOf(fake, name), Schema.decodeUnknownOption(HandedBackData)),
    (data) => data.from,
  );

describe("every hand-off to a person records with-person", () => {
  effect("Implement.handToHuman: the issue and its pull request, with why and from", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, "review-asked");

      yield* runStep(fake, Implement.handToHuman(ISSUE, "the agent gave up", Option.some(PULL)));

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, ISSUE_ITEM)).toEqual(said("the agent gave up"));
      expect(withPersonOf(fake, PR_ITEM)).toEqual(said("the agent gave up", "review-asked"));
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("PullRequest.handToPerson: the pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      const finished = yield* runStep(fake, PullRequest.handToPerson(PULL, "a dispute"));

      expect(finished.status).toBe("needs-human");
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, PR_ITEM)).toEqual(said("a dispute"));
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("Plan.handToHuman: the spec, from the plan it hands back", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(ISSUE_ITEM, "proposed");

      yield* runStep(fake, Plan.handToHuman(ISSUE, "nobody answered"));

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, ISSUE_ITEM)).toEqual(said("nobody answered", "plan-handed-back"));
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("Stack.refreshToPerson, an epic's layer: the layer's pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      yield* runStep(fake, Stack.refreshToPerson(PULL, "layer-1", "the refresh conflicts"));

      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("a plan's human task is with a person when it's created, besides its label", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      const node = (key: string, kind: string) => ({
        key,
        title: `${key}'s task`,
        body: "",
        kind,
        blockedBy: [],
      });

      yield* runStep(
        fake,
        activity("plan", Plan.create(ISSUE, [node("decide", "human"), node("build", "auto")])),
      );

      const made = [...fake.graph.made.values()];

      const issueFor = (key: string) =>
        Option.getOrThrow(
          Option.fromUndefinedOr(made.find((found) => found.title === `${key}'s task`)),
        ).number;

      const human = Phases.issueItem(issueFor("decide"));
      expect(fake.phases()[human]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, human)).toEqual(said(Plan.PERSONS_TASK));
      expect(fake.labelsOf(issueFor("decide"))).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.phases()[Phases.issueItem(issueFor("build"))]).toBeUndefined();
    }),
  );

  effect("a hand-off records no second with-person over one already there", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      yield* runStep(fake, Implement.handToHuman(ISSUE, "first", Option.none()));
      yield* runStep(fake, Implement.handToHuman(ISSUE, "second", Option.none()));

      expect(withPersonOf(fake, ISSUE_ITEM)).toEqual(said("first"));
    }),
  );
});

const passes = (name: string, found: PhaseRecord) =>
  Option.isNone(Ledger.check(Blocks.transitions, ["chernabog-bot"])(name, found));

const unlabeled = (login: string, label: string = DEFAULT_LABELS.needsHuman): Json => ({
  event: "unlabeled",
  label: { name: label },
  actor: { login },
});

const labeled = (login: string): Json => ({
  event: "labeled",
  label: { name: DEFAULT_LABELS.needsHuman },
  actor: { login },
});

// GitHub lists `found` as the events of `number`, and gives PERSON write
// access to the repo; STRANGER, like anyone else, reads it only.
const listing = (fake: Fake, number: number, ...found: ReadonlyArray<Json>) => {
  fake.timeline.events.set(number, found);
  fake.timeline.permissions.set(PERSON, "write");
};

const handingBack = (fake: Fake) => onFake(fake, Phases.reconcileHandedBack);

// The issue, with a person from `from`: as a run handed it over, then its
// label as `labels`.
const withPerson = (labels: ReadonlyArray<string>, from: Option.Option<string>) => {
  const fake = makeFake("approve");

  const left = Option.map(from, (phase) => {
    fake.recordPhase(ISSUE_ITEM, phase);

    return Option.getOrThrow(recordOf(fake, ISSUE_ITEM));
  });

  fake.recordPhase(ISSUE_ITEM, WITH_PERSON, { data: Phases.withPersonData("stuck", left) });
  fake.setLabels(ISSUE, [...labels]);

  return fake;
};

describe("handing an item back is the intent of a trusted person", () => {
  effect("a trusted removal records handed-back, from the phase it went to the person from", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.some("awaiting-ci"));
      listing(fake, ISSUE, unlabeled(PERSON));

      yield* handingBack(fake);

      const found = Option.getOrThrow(recordOf(fake, ISSUE_ITEM));
      expect<string>(found.phase).toBe(HANDED_BACK);
      expect(handedBackFrom(fake, ISSUE_ITEM)).toEqual(Option.some(Option.some("awaiting-ci")));
      expect<string>(found.by).toBe("observer:handed-back");
      expect<Option.Option<string>>(found.from).toEqual(Option.some(WITH_PERSON));
      expect(passes(ISSUE_ITEM, found)).toBe(true);
    }),
  );

  effect("nothing of the phase it left carries over but its name", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, "review-asked", { data: { reviewed: ["data-quail"] } });

      yield* runStep(fake, PullRequest.handToPerson(PULL, "a dispute"));
      expect<Option.Option<Json>>(dataOf(fake, PR_ITEM)).toEqual(
        Option.some({ why: "a dispute", from: "review-asked" }),
      );

      fake.setLabels(PULL, []);
      listing(fake, PULL, unlabeled(PERSON));
      yield* handingBack(fake);

      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
      expect<Option.Option<Json>>(dataOf(fake, PR_ITEM)).toEqual(
        Option.some({ from: "review-asked" }),
      );
    }),
  );

  effect("an item with no phase before it went to the person is handed-back", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      listing(fake, ISSUE, unlabeled(PERSON));

      yield* handingBack(fake);

      const found = Option.getOrThrow(recordOf(fake, ISSUE_ITEM));
      expect<string>(found.phase).toBe(HANDED_BACK);
      expect<string>(found.by).toBe("observer:handed-back");
      expect(handedBackFrom(fake, ISSUE_ITEM)).toEqual(Option.some(Option.none()));
      expect(passes(ISSUE_ITEM, found)).toBe(true);
    }),
  );

  effect("a persona's removal counts too", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      listing(fake, ISSUE, unlabeled("chernabog-bot"));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("a label removed by an untrusted user changes nothing", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      listing(fake, ISSUE, unlabeled(STRANGER));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("the last removal decides: a trusted one before a stranger's changes nothing", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      listing(fake, ISSUE, unlabeled(PERSON), labeled(PERSON), unlabeled(STRANGER));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("the last removal is read past GitHub's first page of events", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      const filler = Array.from({ length: 150 }, (): Json => ({ event: "commented" }));
      listing(fake, ISSUE, unlabeled(PERSON), ...filler, labeled(PERSON), unlabeled(STRANGER));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);

      const trusted = withPerson([], Option.none());
      listing(trusted, ISSUE, unlabeled(STRANGER), ...filler, labeled(PERSON), unlabeled(PERSON));

      yield* handingBack(trusted);

      expect(trusted.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("an item still labelled, or with no removal GitHub lists, stays with a person", () =>
    Effect.gen(function* () {
      const labelled = withPerson([DEFAULT_LABELS.needsHuman], Option.none());
      listing(labelled, ISSUE, unlabeled(PERSON));
      yield* handingBack(labelled);
      expect(labelled.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);

      const unlisted = withPerson([], Option.none());
      listing(unlisted, ISSUE, unlabeled(PERSON, DEFAULT_LABELS.eligible));
      yield* handingBack(unlisted);
      expect(unlisted.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("an item whose events GitHub fails to list is left for the next tick, not the rest", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      fake.recordPhase(PR_ITEM, WITH_PERSON, {
        data: Phases.withPersonData("a dispute", Option.none()),
      });
      listing(fake, ISSUE, unlabeled(PERSON));
      fake.timeline.failing.add(PULL);

      yield* handingBack(fake);

      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );
});

// A projection puts auto:needs-human back on an item whose record is still
// with-person (ADR 21, decision 8). A trusted person's removal before the
// observer's tick is their hand-back all the same (#573): the observer reads
// it from the removal event, so the person's hand-back is never lost.
describe("a hand-back and a projection, in either order", () => {
  // The issue handed to a person by a run, its label projected; then a
  // trusted person takes the label off.
  const removedByPerson = () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* runStep(fake, Implement.handToHuman(ISSUE, "stuck", Option.none()));
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);

      fake.setLabels(
        ISSUE,
        fake.labelsOf(ISSUE).filter((label) => label !== DEFAULT_LABELS.needsHuman),
      );
      listing(fake, ISSUE, ...(fake.timeline.events.get(ISSUE) ?? []), unlabeled(PERSON));

      return fake;
    });

  // A claim on the issue, which projects its labels again.
  const claimed = (fake: Fake) =>
    runStep(fake, StatusLabels.acquire(ISSUE_ITEM).pipe(Effect.orDie));

  effect(
    "a claim before the observer's tick puts the label back; the tick still hands it back",
    () =>
      Effect.gen(function* () {
        const fake = yield* removedByPerson();

        yield* claimed(fake);
        expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
        expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);

        yield* handingBack(fake);

        expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
        expect(fake.labelsOf(ISSUE)).not.toContain(DEFAULT_LABELS.needsHuman);
      }),
  );

  effect("an advance of the epic sharing the issue, before the tick, loses nothing either", () =>
    Effect.gen(function* () {
      const fake = yield* removedByPerson();

      yield* onFake(fake, StatusLabels.projectItem(Claims.epic(ISSUE)));
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("a claim after the observer's tick projects the hand-back: no label", () =>
    Effect.gen(function* () {
      const fake = yield* removedByPerson();

      yield* handingBack(fake);
      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);

      yield* claimed(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
      expect(fake.labelsOf(ISSUE)).not.toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("a person who puts the label back after removing it keeps the item", () =>
    Effect.gen(function* () {
      const fake = yield* removedByPerson();
      fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), DEFAULT_LABELS.needsHuman]);
      listing(fake, ISSUE, ...(fake.timeline.events.get(ISSUE) ?? []), labeled(PERSON));

      yield* claimed(fake);
      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("a removal from before the item went to the person hands nothing back", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, []);
      fake.recordPhase(ISSUE_ITEM, WITH_PERSON, {
        at: DateTime.makeUnsafe("2026-06-01T00:00:00Z"),
        data: Phases.withPersonData("stuck again", Option.none()),
      });
      listing(fake, ISSUE, {
        event: "unlabeled",
        label: { name: DEFAULT_LABELS.needsHuman },
        actor: { login: PERSON },
        created_at: "2026-05-01T00:00:00Z",
      });

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );
});

// A pull request the review flows had, handed to a person and handed back:
// its record says handed-back, from the review phase it left. The flows act
// on that record, not on the phase it left (ADR 21, decision 1); taking one
// up again from changes asked or a review asked again is #561's.
describe("a pull request handed back records handed-back, from its review phase", () => {
  const REVIEWER = "data-quail";

  effect("changes asked: handed-back from changes-asked", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.people.me = "chernabog-bot";
      fake.submitted.push({ author: REVIEWER, state: "CHANGES_REQUESTED", commitSha: HEAD });
      fake.recordPhase(PR_ITEM, "changes-asked");

      yield* runStep(fake, PullRequest.handToPerson(PULL, "the agent disputes the review"));
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(yield* flowTriggered(fake, addressReview)).toEqual([]);

      fake.setLabels(PULL, []);
      listing(fake, PULL, unlabeled(PERSON));
      yield* handingBack(fake);

      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
      expect(handedBackFrom(fake, PR_ITEM)).toEqual(Option.some(Option.some("changes-asked")));
    }),
  );

  effect("a review asked again: handed-back from review-asked-again", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.people.me = REVIEWER;
      fake.people.requested = [REVIEWER];
      fake.recordPhase(PR_ITEM, "review-asked-again");

      yield* runStep(fake, PullRequest.handToPerson(PULL, "too many rounds"));
      expect(yield* flowTriggered(fake, reReview)).toEqual([]);

      fake.setLabels(PULL, []);
      listing(fake, PULL, unlabeled(PERSON));
      yield* handingBack(fake);

      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
      expect(handedBackFrom(fake, PR_ITEM)).toEqual(Option.some(Option.some("review-asked-again")));
    }),
  );

  effect("one with no phase before it: a review asked of it is a first review", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.people.me = REVIEWER;
      fake.people.requested = [REVIEWER];

      yield* runStep(fake, PullRequest.handToPerson(PULL, "a person's call"));
      fake.setLabels(PULL, []);
      listing(fake, PULL, unlabeled(PERSON));

      const found = yield* flowTriggered(fake, review);

      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
      expect(found.map((work) => Option.fromUndefinedOr(work.held))).toEqual([Option.none()]);
      expect(found).toHaveLength(1);
    }),
  );

  effect("a stranger's removal leaves it with the person: no flow takes it up", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.people.me = "chernabog-bot";
      fake.submitted.push({ author: REVIEWER, state: "CHANGES_REQUESTED", commitSha: HEAD });
      fake.recordPhase(PR_ITEM, "changes-asked");

      yield* runStep(fake, PullRequest.handToPerson(PULL, "the agent disputes the review"));
      fake.setLabels(PULL, []);
      listing(fake, PULL, unlabeled(STRANGER));

      expect(yield* flowTriggered(fake, addressReview)).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );
});

describe("the ledger's check knows with-person and handed-back", () => {
  effect("a run records with-person from any phase; the observer moves on only from it", () =>
    Effect.sync(() => {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, "approved");
      fake.recordPhase(PR_ITEM, WITH_PERSON);
      fake.recordPhase(Claims.epic(ISSUE), WITH_PERSON);
      fake.recordPhase(ISSUE_ITEM, WITH_PERSON);
      fake.recordPhase(ISSUE_ITEM, HANDED_BACK, { by: "observer:handed-back" });

      for (const name of [PR_ITEM, Claims.epic(ISSUE), ISSUE_ITEM]) {
        expect(passes(name, Option.getOrThrow(recordOf(fake, name)))).toBe(true);
      }

      fake.recordPhase(PR_ITEM, WITH_PERSON);
      fake.recordPhase(PR_ITEM, "changes-asked", { by: "observer:handed-back" });
      expect(passes(PR_ITEM, Option.getOrThrow(recordOf(fake, PR_ITEM)))).toBe(false);

      fake.recordPhase(ISSUE_ITEM, "awaiting-ci", { by: EARLIER_RUN });
      fake.recordPhase(ISSUE_ITEM, HANDED_BACK, { by: "observer:handed-back" });
      expect(passes(ISSUE_ITEM, Option.getOrThrow(recordOf(fake, ISSUE_ITEM)))).toBe(false);

      fake.recordPhase(ISSUE_ITEM, "awaiting-ci", { by: "observer:handed-back" });
      expect(passes(ISSUE_ITEM, Option.getOrThrow(recordOf(fake, ISSUE_ITEM)))).toBe(false);
    }),
  );
});

describe("progress backfill's items with a person", () => {
  effect("an open item labelled auto:needs-human with no with-person record gets one", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.needsHuman]);
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      fake.recordPhase(PR_ITEM, "review-asked");

      const findings = yield* onFake(fake, Backfill.survey);
      const written = yield* onFake(fake, Backfill.apply(findings));

      expect(written.every((each) => each.written)).toBe(true);
      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, PR_ITEM)).toEqual(
        said("labelled auto:needs-human", "review-asked"),
      );
      expect(Option.map(recordOf(fake, ISSUE_ITEM), (found): string => found.by)).toEqual(
        Option.some("observer:backfill"),
      );

      for (const name of [ISSUE_ITEM, PR_ITEM]) {
        expect(passes(name, Option.getOrThrow(recordOf(fake, name)))).toBe(true);
      }

      expect(yield* onFake(fake, Backfill.survey)).toEqual([]);
    }),
  );

  effect("an item recorded with-person already, or unlabelled, is left alone", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.needsHuman]);
      fake.recordPhase(ISSUE_ITEM, WITH_PERSON);

      const findings = yield* onFake(fake, Backfill.survey);

      expect(findings.filter((found) => found.item === ISSUE_ITEM)).toEqual([]);
      expect(findings.filter((found) => found.item === PR_ITEM)).not.toContainEqual(
        expect.objectContaining({ phase: WITH_PERSON }),
      );
    }),
  );
});

describe("what a hand-back reads of GitHub", () => {
  const REVIEWER_PERSONA = "chernabog-reviewer";

  // The issue with a person, from no phase, on a repo run as two personas.
  const twoPersonas = () => {
    const fake = makeFake("approve", { personas: ["chernabog-bot", REVIEWER_PERSONA] });
    fake.recordPhase(ISSUE_ITEM, WITH_PERSON, {
      data: Phases.withPersonData("stuck", Option.none()),
    });
    fake.setLabels(ISSUE, []);

    return fake;
  };

  effect("admin and maintain access count as write does", () =>
    Effect.gen(function* () {
      for (const permission of ["admin", "maintain"]) {
        const fake = withPerson([], Option.none());
        listing(fake, ISSUE, unlabeled(PERSON));
        fake.timeline.permissions.set(PERSON, permission);

        yield* handingBack(fake);

        expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
      }
    }),
  );

  effect("triage access doesn't", () =>
    Effect.gen(function* () {
      const fake = withPerson([], Option.none());
      listing(fake, ISSUE, unlabeled(PERSON));
      fake.timeline.permissions.set(PERSON, "triage");

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("any of the repo's personas is trusted, not only the one acting", () =>
    Effect.gen(function* () {
      const fake = twoPersonas();
      listing(fake, ISSUE, unlabeled(REVIEWER_PERSONA));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("any persona's projection putting the label back keeps the person's hand-back", () =>
    Effect.gen(function* () {
      const fake = twoPersonas();
      fake.setLabels(ISSUE, [DEFAULT_LABELS.needsHuman]);
      listing(fake, ISSUE, unlabeled(PERSON), labeled(REVIEWER_PERSONA));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("a removal GitHub dates at or after the record counts", () =>
    Effect.gen(function* () {
      for (const removed of ["2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"]) {
        const fake = makeFake("approve");
        fake.setLabels(ISSUE, []);
        fake.recordPhase(ISSUE_ITEM, WITH_PERSON, {
          at: DateTime.makeUnsafe("2026-06-01T00:00:00Z"),
          data: Phases.withPersonData("stuck", Option.none()),
        });
        listing(fake, ISSUE, {
          event: "unlabeled",
          label: { name: DEFAULT_LABELS.needsHuman },
          actor: { login: PERSON },
          created_at: removed,
        });

        yield* handingBack(fake);

        expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
      }
    }),
  );

  effect("a removal on the thirtieth page of events counts; past it, nothing is read", () =>
    Effect.gen(function* () {
      const filler = (count: number) =>
        Array.from({ length: count }, (): Json => ({ event: "commented" }));

      const last = withPerson([], Option.none());
      listing(last, ISSUE, ...filler(2900), unlabeled(PERSON));
      yield* handingBack(last);
      expect(last.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);

      const past = withPerson([], Option.none());
      listing(past, ISSUE, ...filler(3000), unlabeled(PERSON));
      yield* handingBack(past);
      expect(past.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("only a with-person record is handed back", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(ISSUE_ITEM, "awaiting-ci");
      fake.setLabels(ISSUE, []);
      listing(fake, ISSUE, unlabeled(PERSON));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe("awaiting-ci");
    }),
  );

  effect("a closed issue, or a closed pull request, stays with a person", () =>
    Effect.gen(function* () {
      const issue = withPerson([], Option.none());
      listing(issue, ISSUE, unlabeled(PERSON));
      issue.states.issue = "closed";
      yield* handingBack(issue);
      expect(issue.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);

      const pull = makeFake("approve");
      pull.recordPhase(PR_ITEM, WITH_PERSON, {
        data: Phases.withPersonData("a dispute", Option.none()),
      });
      pull.setLabels(PULL, []);
      listing(pull, PULL, unlabeled(PERSON));
      pull.states.pull = "closed";
      yield* handingBack(pull);
      expect(pull.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("a pull request's labels are its own, not its issue's", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, WITH_PERSON, {
        data: Phases.withPersonData("a dispute", Option.none()),
      });
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      fake.setLabels(ISSUE, []);
      listing(fake, PULL, unlabeled(PERSON));

      yield* handingBack(fake);

      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("an issue GitHub knows no more, or a team's own item, is left; the rest go on", () =>
    Effect.gen(function* () {
      const GONE = 99;
      const fake = withPerson([], Option.none());
      listing(fake, ISSUE, unlabeled(PERSON));
      fake.recordPhase(Phases.issueItem(GONE), WITH_PERSON);
      fake.timeline.gone.add(GONE);
      listing(fake, GONE, unlabeled(PERSON));
      fake.recordPhase("spec-checkout", WITH_PERSON);

      yield* handingBack(fake);

      expect(fake.phases()[Phases.issueItem(GONE)]).toBe(WITH_PERSON);
      expect(fake.phases()["spec-checkout"]).toBe(WITH_PERSON);
      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("a with-person record that keeps no data is handed back from no phase", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(ISSUE_ITEM, WITH_PERSON);
      fake.setLabels(ISSUE, []);
      listing(fake, ISSUE, unlabeled(PERSON));

      yield* handingBack(fake);

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
      expect(handedBackFrom(fake, ISSUE_ITEM)).toEqual(Option.some(Option.none()));
    }),
  );
});
