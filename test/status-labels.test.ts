// Status labels are a projection of the ledger (ADR 21, decision 8): one
// projector, StatusLabels, derives them from an item's phase and its claim
// after every advance and every claim change, and writes exactly that set.
// No flow or block writes one. A status label a person adds or removes by
// hand is put right by the next projection and changes no run's behaviour;
// intent labels, and labels chernabog doesn't own, are never touched.

import {
  Claims,
  DEFAULT_LABELS,
  type FlowError,
  type Json,
  Phase,
  PhaseData,
  type PhaseRecord,
  PhaseWriter,
  StepFailed,
  type WorkflowServices,
} from "@chernabog/core";
import { defineFlow, Phases, Plan, Settings, StatusLabels } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import implement from "../packages/recipes/flows/implement.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { type Fake, ISSUE, item, makeFake, onFake, PULL, repo, runToEnd } from "./sdk-fakes.ts";

const ISSUE_ITEM = Phases.issueItem(ISSUE);
const PR_ITEM = Phases.pullRequestItem(PULL);
const NAMES = StatusLabels.DEFAULT_NAMES;
const STATUS = StatusLabels.statusOf(NAMES);
const INTENT = StatusLabels.intentOf(NAMES);

// A label of the repo's own, which chernabog doesn't own.
const FOREIGN = "bug";

const recordAt = (phase: string, data?: { readonly [key: string]: Json }): PhaseRecord => ({
  phase: Schema.decodeSync(Phase)(phase),
  from: Option.none(),
  by: Schema.decodeSync(PhaseWriter)("a-run"),
  version: "v1",
  at: DateTime.makeUnsafe(0),
  data: Option.map(Option.fromUndefinedOr(data), Schema.decodeSync(PhaseData)),
  blobs: [],
});

const holder: Claims.Holder = {
  runId: "a-run",
  persona: "chernabog-bot",
  flow: "implement",
  claimedAt: "2026-11-22T00:00:00Z",
  withPerson: false,
};

const claimed = Option.some(holder);
const free = Option.none<Claims.Holder>();

const project = (
  name: string,
  phase: Option.Option<string>,
  claim: Option.Option<Claims.Holder> = free,
  data?: { readonly [key: string]: Json },
) =>
  StatusLabels.project(
    name,
    Option.map(phase, (found) => recordAt(found, data)),
    claim,
  );

describe("StatusLabels.project: the mapping from phase and claim", () => {
  test("every label of Settings.LabelNames is status or intent, never both", () => {
    for (const label of Object.values(Settings.DEFAULT_LABEL_NAMES)) {
      expect(STATUS.includes(label) !== INTENT.includes(label)).toBe(true);
    }

    expect(STATUS.filter((label) => INTENT.includes(label))).toEqual([]);
    expect(INTENT).toEqual([
      "auto:eligible",
      "auto:ship",
      "hybrid",
      "auto:plan",
      "auto:plan-approved",
      "auto:epic",
    ]);
  });

  test("an issue a run holds is in progress, until its record says the run let it go", () => {
    expect(project(ISSUE_ITEM, Option.none(), claimed)).toEqual(["auto:in-progress"]);
    expect(project(ISSUE_ITEM, Option.some("handed-back"), claimed)).toEqual(["auto:in-progress"]);
    expect(project(ISSUE_ITEM, Option.none())).toEqual([]);

    for (const letGo of ["handed-off", "became-epic"]) {
      expect(project(ISSUE_ITEM, Option.some(letGo), claimed)).toEqual([]);
    }
  });

  test("an issue's phases", () => {
    expect(project(ISSUE_ITEM, Option.some("with-person"), claimed)).toEqual(["auto:needs-human"]);
    expect(project(ISSUE_ITEM, Option.some("asked-questions"))).toEqual([
      "auto:needs-clarification",
    ]);
    expect(project(ISSUE_ITEM, Option.some("awaiting-ready"))).toEqual(["auto:awaiting-ready"]);
    expect(project(ISSUE_ITEM, Option.some("proposed"))).toEqual(["auto:plan-proposed"]);
    expect(project(ISSUE_ITEM, Option.some("awaiting-ci"))).toEqual([]);
  });

  test("a pull request's phases, whoever holds its claim", () => {
    expect(project(PR_ITEM, Option.some("with-person"), claimed)).toEqual(["auto:needs-human"]);
    expect(project(PR_ITEM, Option.some("changes-asked"))).toEqual(["auto:changes-requested"]);
    expect(project(PR_ITEM, Option.some("approved"))).toEqual(["auto:approved"]);
    expect(project(PR_ITEM, Option.some("ready-for-person"))).toEqual(["auto:ready-for-person"]);
    expect(project(PR_ITEM, Option.some("review-asked"), claimed)).toEqual([]);
    expect(project(PR_ITEM, Option.some("review-asked"), free, { unasked: true })).toEqual([
      "auto:needs-review",
    ]);
    expect(project(PR_ITEM, Option.some("approved"), free, { adopted: true })).toEqual([
      "auto:approved",
      "auto:adopted",
    ]);
    expect(project(PR_ITEM, Option.none(), claimed)).toEqual([]);
  });

  test("an epic's, and an item that names no issue or pull request", () => {
    expect(project(Claims.epic(ISSUE), Option.some("with-person"), claimed)).toEqual([
      "auto:needs-human",
    ]);
    expect(project(Claims.epic(ISSUE), Option.some("waiting"), claimed)).toEqual([]);
    expect(project("a-team-item", Option.some("with-person"), claimed)).toEqual([]);
  });

  test("a repo's own names", () => {
    expect(
      StatusLabels.project(ISSUE_ITEM, Option.some(recordAt("with-person")), free, {
        ...NAMES,
        needsHuman: "help-wanted",
      }),
    ).toEqual(["help-wanted"]);
  });
});

// A run of a flow whose workflow is `step`: a failure of its own fails the run.
const runStep = <A, E>(fake: Fake, step: Effect.Effect<A, E, WorkflowServices>) =>
  runToEnd(
    flowHandle(
      repo,
      "projected",
      defineFlow({
        trigger: Effect.succeed([]),
        workflow: () =>
          step.pipe(
            Effect.as("done"),
            Effect.mapError(
              (error): FlowError => new StepFailed({ step: "projected", message: String(error) }),
            ),
          ),
      }),
    ),
    fake,
    item("projected"),
  );

const statusOn = (fake: Fake, number: number) =>
  fake.labelsOf(number).filter((label) => STATUS.includes(label));

describe("the projector writes exactly the projection", () => {
  effect("after an advance, leaving intent and foreign labels as they are", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      const others = [...INTENT, FOREIGN];
      fake.setLabels(ISSUE, [...others, DEFAULT_LABELS.stale, DEFAULT_LABELS.inProgress]);

      yield* runStep(fake, Phases.handToPerson(ISSUE_ITEM, "a person decides"));

      expect(statusOn(fake, ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.labelsOf(ISSUE).filter((label) => !STATUS.includes(label))).toEqual(others);
    }),
  );

  effect("a status label removed or added by hand is put right by the next projection", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, "review-asked");
      fake.setLabels(PULL, [FOREIGN]);

      yield* onFake(
        fake,
        Phases.reconcile(
          PR_ITEM,
          Option.fromUndefinedOr(fake.records().get(PR_ITEM)),
          "changes-asked",
          "observer:review.changesRequested",
        ),
      );
      expect(statusOn(fake, PULL)).toEqual([DEFAULT_LABELS.changesRequested]);

      // A person takes it off, and puts on two that the record doesn't say.
      fake.setLabels(PULL, [FOREIGN, DEFAULT_LABELS.approved, DEFAULT_LABELS.stale]);

      yield* onFake(fake, StatusLabels.projectItem(PR_ITEM));

      expect(statusOn(fake, PULL)).toEqual([DEFAULT_LABELS.changesRequested]);
      expect(fake.labelsOf(PULL)).toContain(FOREIGN);
    }),
  );

  effect("an issue's and its epic's projections share its labels", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(ISSUE_ITEM, "became-epic");
      fake.recordPhase(Claims.epic(ISSUE), "with-person", { data: { why: "stuck" } });
      fake.setLabels(ISSUE, [Plan.LABELS.epic]);

      yield* onFake(fake, StatusLabels.projectItem(ISSUE_ITEM));

      expect(fake.labelsOf(ISSUE)).toEqual([Plan.LABELS.epic, DEFAULT_LABELS.needsHuman]);
    }),
  );
});

describe("a claim's in-progress label follows the claim", () => {
  effect("on while the run holds it, off once the run ends, however it ends", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      const during: Array<ReadonlyArray<string>> = [];

      const finished = yield* runStep(
        fake,
        Effect.gen(function* () {
          yield* StatusLabels.acquire(ISSUE_ITEM);
          during.push(statusOn(fake, ISSUE));

          return yield* new StepFailed({ step: "work", message: "it broke" });
        }),
      );

      expect(finished.status).toBe("failed");
      expect(during).toEqual([[DEFAULT_LABELS.inProgress]]);
      expect(statusOn(fake, ISSUE)).toEqual([]);
      // The queue label is intent: acquire leaves it to the flow to acknowledge.
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.eligible);
    }),
  );

  effect("released mid-run, the label goes with it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, []);
      const during: Array<ReadonlyArray<string>> = [];

      yield* runStep(
        fake,
        Effect.gen(function* () {
          yield* StatusLabels.acquire(ISSUE_ITEM);
          yield* StatusLabels.release(ISSUE_ITEM);
          during.push(statusOn(fake, ISSUE));
        }),
      );

      expect(during).toEqual([[]]);
    }),
  );
});

// What a run of implement leaves: its ending, every item's phase, and the
// status labels on the issue and its pull request.
const outcomeOf = (fake: Fake, finished: { readonly status: string }) => ({
  status: finished.status,
  phases: fake.phases(),
  issue: statusOn(fake, ISSUE).toSorted(),
  pull: statusOn(fake, PULL).toSorted(),
});

describe("status labels changed by hand change no run's behaviour", () => {
  effect("implement runs alike with every status label added, or none", () =>
    Effect.gen(function* () {
      const implementing = flowHandle(repo, "implement", implement);

      const clean = makeFake("approve", { reviewers: ["a-reviewer"] });
      clean.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      clean.setLabels(PULL, []);

      const cleanRun = yield* runToEnd(
        implementing,
        clean,
        item(`issue-${ISSUE}`, { issue: ISSUE }),
      );

      const sabotaged = makeFake("approve", { reviewers: ["a-reviewer"] });
      sabotaged.setLabels(ISSUE, [DEFAULT_LABELS.eligible, ...STATUS]);
      sabotaged.setLabels(PULL, [...STATUS]);

      const sabotagedRun = yield* runToEnd(
        implementing,
        sabotaged,
        item(`issue-${ISSUE}`, { issue: ISSUE }),
      );

      expect(cleanRun.status).toBe("done");
      expect(outcomeOf(sabotaged, sabotagedRun)).toEqual(outcomeOf(clean, cleanRun));
    }),
  );
});

describe("chernabog doctor lists the labels that differ from their projection", () => {
  effect("an open item a person relabelled by hand, and none that match", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(ISSUE_ITEM, "asked-questions");
      fake.recordPhase(PR_ITEM, "approved");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible, DEFAULT_LABELS.needsHuman]);
      fake.setLabels(PULL, [DEFAULT_LABELS.approved, FOREIGN]);

      const drifted = yield* onFake(fake, StatusLabels.drifted);

      expect(drifted).toEqual([
        {
          item: ISSUE_ITEM,
          number: ISSUE,
          missing: [DEFAULT_LABELS.needsClarification],
          extra: [DEFAULT_LABELS.needsHuman],
        },
      ]);
    }),
  );
});
