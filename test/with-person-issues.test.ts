// The issue, plan and epic sources read "with a person" from the item's
// record, not from auto:needs-human, its projection (ADR 21, decision 1;
// #560). The label deleted by someone the repo doesn't trust leaves the item
// with the person; the label added by hand, with no with-person record,
// hands nothing over; and an item a trusted person hands back is taken up
// again.

import { Run } from "@chernabog/core";
import {
  Claims,
  DEFAULT_LABELS,
  Epic,
  Implement,
  type Json,
  Phases,
  Plan,
  planNodeMarker,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import implement from "../packages/recipes/flows/implement.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  flowTriggered,
  ISSUE,
  item,
  makeFake,
  onFake,
  PULL,
  triggered,
} from "./sdk-fakes.ts";

const ISSUE_ITEM = Phases.issueItem(ISSUE);
const PR_ITEM = Phases.pullRequestItem(PULL);
const WITH_PERSON = "with-person";
const PERSON = "a-maintainer";
const STRANGER = "a-stranger";

const unlabeled = (login: string): Json => ({
  event: "unlabeled",
  label: { name: DEFAULT_LABELS.needsHuman },
  actor: { login },
});

// `login` took auto:needs-human off `number`, by GitHub's events; PERSON has
// write access to the repo, and STRANGER, like anyone else, reads it only.
const unlabelledBy = (fake: Fake, number: number, login: string) => {
  fake.setLabels(
    number,
    fake.labelsOf(number).filter((label) => label !== DEFAULT_LABELS.needsHuman),
  );
  fake.timeline.events.set(number, [unlabeled(login)]);
  fake.timeline.permissions.set(PERSON, "write");
};

// `name` is with a person, from the record it holds, and labelled so.
const handedOver = (fake: Fake, name: string, number: number) => {
  const left = Option.fromUndefinedOr(fake.records().get(name));
  fake.recordPhase(name, WITH_PERSON, { data: Phases.withPersonData("stuck", left) });
  fake.setLabels(number, [...fake.labelsOf(number), DEFAULT_LABELS.needsHuman]);
};

const handingBack = (fake: Fake) => onFake(fake, Phases.reconcileHandedBack);

describe("the implement recipe's CI-wait source", () => {
  // The issue's run parked on its pull request's CI, which has since gone green.
  const parkedInCi = () => {
    const fake = makeFake("approve", { reviewers: ["zach", "data-quail"], ciJob: true });
    fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
    fake.git.opened = true;
    fake.recordPhase(ISSUE_ITEM, Phases.awaitingCi(1));

    return fake;
  };

  const resumes = (fake: Fake) =>
    flowTriggered(fake, implement).pipe(
      Effect.map((items) => items.filter((found) => Option.isSome(Implement.resumingCi(found)))),
      Effect.orDie,
    );

  effect("the label added by hand, with no with-person record, hands nothing over", () =>
    Effect.gen(function* () {
      const fake = parkedInCi();
      fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress, DEFAULT_LABELS.needsHuman]);

      expect((yield* resumes(fake)).map((found) => found.key)).toEqual([ISSUE_ITEM]);
    }),
  );

  effect("an issue a trusted person hands back is taken up again", () =>
    Effect.gen(function* () {
      const fake = parkedInCi();
      handedOver(fake, ISSUE_ITEM, ISSUE);
      expect(yield* resumes(fake)).toEqual([]);

      unlabelledBy(fake, ISSUE, PERSON);

      expect((yield* resumes(fake)).map((found) => found.key)).toEqual([ISSUE_ITEM]);
      expect(fake.phases()[ISSUE_ITEM]).toBe(Phases.awaitingCi(1));
    }),
  );

  effect("an issue whose label a stranger deletes stays with the person", () =>
    Effect.gen(function* () {
      const fake = parkedInCi();
      handedOver(fake, ISSUE_ITEM, ISSUE);
      unlabelledBy(fake, ISSUE, STRANGER);

      expect(yield* resumes(fake)).toEqual([]);
      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );
});

describe("a document's run parked on a pull request's CI", () => {
  const work = item(ISSUE_ITEM, { issue: ISSUE });

  const resumes = (fake: Fake) =>
    onFake(fake, Implement.documentCiResumes({ pullRequest: PULL }, work)).pipe(Effect.orDie);

  effect("its pull request's label deleted by a stranger leaves it with the person", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      handedOver(fake, PR_ITEM, PULL);
      unlabelledBy(fake, PULL, STRANGER);
      yield* handingBack(fake);

      expect(yield* resumes(fake)).toEqual(Option.none());
    }),
  );

  effect("its pull request's label added by hand, with no record, holds nothing", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);

      expect(Option.isSome(yield* resumes(fake))).toBe(true);
    }),
  );
});

describe("a plan waiting on a person's answer", () => {
  const SPEC_ITEM = ISSUE_ITEM;

  // The plan of round 1 is posted on the spec, and a person approved it.
  const approved = () => {
    const fake = makeFake("approve");
    fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress, Plan.LABELS.approved]);
    fake.recordPhase(SPEC_ITEM, "proposed", { data: { round: 1 } });
    fake.comment(`## Proposed plan\n\n${'<!-- chernabog-plan {"round":1} -->'}`);

    return fake;
  };

  effect("the recipe's answers: the label added by hand hands nothing over", () =>
    Effect.gen(function* () {
      const fake = approved();
      fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), DEFAULT_LABELS.needsHuman]);

      const found = yield* triggered(fake, Plan.answers).pipe(Effect.orDie);

      expect(found.map((one) => [one.key, one.signals])).toEqual([[SPEC_ITEM, ["approved"]]]);
    }),
  );

  const documentResumes = (fake: Fake) =>
    onFake(
      fake,
      Plan.documentAnswerResumes(
        { round: 1, within: "3 days" },
        item(SPEC_ITEM, { issue: ISSUE }),
        DateTime.makeUnsafe("2026-11-20T00:00:00Z"),
      ),
    ).pipe(Effect.orDie);

  effect("the document's: a spec whose label a stranger deletes stays with the person", () =>
    Effect.gen(function* () {
      const fake = approved();
      handedOver(fake, SPEC_ITEM, ISSUE);
      unlabelledBy(fake, ISSUE, STRANGER);
      yield* handingBack(fake);

      expect(yield* documentResumes(fake)).toEqual(Option.none());
    }),
  );

  effect("the document's: the label added by hand hands nothing over", () =>
    Effect.gen(function* () {
      const fake = approved();
      fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), DEFAULT_LABELS.needsHuman]);

      expect(Option.isSome(yield* documentResumes(fake))).toBe(true);
    }),
  );
});

describe("an epic's task kinds", () => {
  const EPIC = 40;
  const TASK = 10;
  const TASK_ITEM = Phases.issueItem(TASK);

  // A task of the epic, labelled `labels`.
  const task = (labels: ReadonlyArray<string>) => {
    const fake = makeFake("approve");
    fake.graph.made.set(TASK, {
      number: TASK,
      title: `Task ${TASK}`,
      body: `What to do.\n\n${planNodeMarker.write({ spec: EPIC, key: "build" })}`,
      url: `https://github.com/dataquail/demo/issues/${TASK}`,
      createdAt: "2026-10-21T00:00:00Z",
      labels: [],
      assignees: [],
      state: "open",
    });
    fake.setLabels(TASK, [...labels]);
    fake.graph.blockedBy.set(TASK, []);
    fake.graph.subIssues.set(EPIC, [TASK]);

    return fake;
  };

  const EPIC_RUN = { flow: "epic", runId: "this-run", executionId: "e", item: item("epic-40") };

  // The epic's progress, as its run reads it.
  const progressIn = (fake: Fake) =>
    Effect.provide(
      Epic.progressOf(EPIC),
      Layer.mergeAll(fake.services, Layer.succeed(Run, Run.of(EPIC_RUN))),
    );

  const kinds = (fake: Fake) =>
    Effect.map(onFake(fake, Epic.tasks(EPIC)), (found) => found.tasks.map((one) => one.kind));

  effect("a task labelled auto:needs-human by hand, with no record, is not a person's", () =>
    Effect.gen(function* () {
      expect(yield* kinds(task([DEFAULT_LABELS.needsHuman]))).toEqual(["hybrid"]);
      expect(yield* kinds(task([DEFAULT_LABELS.eligible, DEFAULT_LABELS.needsHuman]))).toEqual([
        "auto",
      ]);
    }),
  );

  effect("a task whose label a stranger deletes stays a person's", () =>
    Effect.gen(function* () {
      const fake = task([DEFAULT_LABELS.eligible]);
      handedOver(fake, TASK_ITEM, TASK);
      unlabelledBy(fake, TASK, STRANGER);
      yield* handingBack(fake);

      expect(yield* kinds(fake)).toEqual(["human"]);
    }),
  );

  effect("a task a trusted person hands back is an agent's again", () =>
    Effect.gen(function* () {
      const fake = task([DEFAULT_LABELS.eligible]);
      handedOver(fake, TASK_ITEM, TASK);
      expect(yield* kinds(fake)).toEqual(["human"]);

      unlabelledBy(fake, TASK, PERSON);
      yield* handingBack(fake);

      expect(fake.phases()[TASK_ITEM]).toBe("handed-back");
      expect(yield* kinds(fake)).toEqual(["auto"]);
    }),
  );

  effect("the epic's progress says a person's task needs a person, by its record", () =>
    Effect.gen(function* () {
      const fake = task([]);
      handedOver(fake, TASK_ITEM, TASK);
      fake.setLabels(TASK, []);
      fake.branchPulls.delete(Claims.branchFor(TASK));

      const progress = yield* progressIn(fake);

      expect(progress.layers.map((layer) => [layer.state, layer.reason])).toEqual([
        ["person", "needs a person"],
      ]);
    }),
  );
});
