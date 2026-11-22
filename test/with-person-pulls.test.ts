// The pull request sources read "with a person" from the record, not the
// auto:needs-human label, which is only its projection (ADR 21, decision 1;
// #561). A pull request whose record is with-person stays with the person
// whatever happens to its label short of a trusted person's hand-back; a
// label added by hand, with no record, holds nothing; and a hand-back,
// recorded handed-back {from}, takes the pull request up again by the phase
// it went to the person from: address-review from changes-asked, re-review
// from review-asked-again, and review's first review from anything else.

import {
  type FlowError,
  type PhaseRecord,
  type WorkflowServices,
  type WorkItem,
} from "@chernabog/core";
import {
  Blocks,
  Conflict,
  DEFAULT_LABELS,
  defineFlow,
  Ledger,
  Phases,
  PullRequest,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import resolveConflicts from "../packages/recipes/flows/resolve-conflicts.ts";
import review from "../packages/recipes/flows/review.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
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
  triggered,
} from "./sdk-fakes.ts";

const PR_ITEM = Phases.pullRequestItem(PULL);
const WITH_PERSON = "with-person";
const HANDED_BACK = "handed-back";
const PERSON = "a-maintainer";
const STRANGER = "a-stranger";
const REVIEWER = "data-quail";

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
    item("pull-request"),
  );

// What a document source finds on the fake, as its document's trigger runs it.
const sourceFound = (
  fake: Fake,
  name: "review.requested" | "review.requestedAgain" | "review.changesRequested" | "pr.conflicting",
) =>
  flowTriggered(
    fake,
    defineFlow({
      trigger: Blocks.sources[name].find().trigger,
      workflow: () => Effect.succeed("done"),
    }),
  );

const recordOf = (fake: Fake) =>
  Option.getOrThrow(Option.fromUndefinedOr(fake.records().get(PR_ITEM)));

const passes = (found: PhaseRecord) =>
  Option.isNone(Ledger.check(Blocks.transitions, ["chernabog-bot"])(PR_ITEM, found));

const keysOf = (found: ReadonlyArray<WorkItem>) => found.map((work) => work.key);

// GitHub says `login` took auto:needs-human off the pull request, and gives
// PERSON write access to the repo; STRANGER, like anyone else, reads it only.
const removedBy = (fake: Fake, login: string) => {
  fake.setLabels(PULL, []);
  fake.timeline.events.set(PULL, [
    { event: "unlabeled", label: { name: DEFAULT_LABELS.needsHuman }, actor: { login } },
  ]);
  fake.timeline.permissions.set(PERSON, "write");
};

// The pull request, handed to a person by a run, from `phase`.
const withPersonFrom = (fake: Fake, phase: Option.Option<string>) =>
  Effect.gen(function* () {
    for (const found of Option.toArray(phase)) {
      fake.recordPhase(PR_ITEM, found);
    }

    yield* runStep(fake, PullRequest.handToPerson(PULL, "a dispute"));
    expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
  });

// The pull request, handed back by a person after it went to them from
// `from`: with-person, then handed-back {from}, as observer:handed-back
// records it, with nothing else of the phase it left.
const handedBackFrom = (fake: Fake, from: Option.Option<string>) => {
  for (const found of Option.toArray(from)) {
    fake.recordPhase(PR_ITEM, found);
  }

  fake.recordPhase(PR_ITEM, WITH_PERSON, {
    data: Phases.withPersonData("a dispute", Option.none()),
  });
  fake.recordPhase(PR_ITEM, HANDED_BACK, {
    by: Phases.HANDED_BACK_BY,
    data: { from: Option.getOrNull(from) },
  });
  fake.setLabels(PULL, []);
};

// The persona's own pull request, with changes asked on its head.
const changesOnHead = () => {
  const fake = makeFake("approve");
  fake.people.me = "chernabog-bot";
  fake.setLabels(PULL, []);
  fake.submitted.push({ author: REVIEWER, state: "CHANGES_REQUESTED", commitSha: HEAD });

  return fake;
};

// A pull request that asks REVIEWER, this persona, for a review.
const reviewAsked = () => {
  const fake = makeFake("approve");
  fake.people.me = REVIEWER;
  fake.people.requested = [REVIEWER];
  fake.setLabels(PULL, []);

  return fake;
};

// The persona's own pull request, which GitHub says conflicts with its base.
const conflicting = () => {
  const fake = makeFake("approve");
  fake.setLabels(PULL, []);
  fake.merge.state = "dirty";

  return fake;
};

describe("a pull request with a person stays with them when a stranger takes the label off", () => {
  effect("review: no first review, and nothing held for status", () =>
    Effect.gen(function* () {
      const fake = reviewAsked();
      yield* withPersonFrom(fake, Option.some("review-asked"));
      removedBy(fake, STRANGER);

      expect(yield* flowTriggered(fake, review)).toEqual([]);
      expect(yield* sourceFound(fake, "review.requested")).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("re-review: no review again", () =>
    Effect.gen(function* () {
      const fake = reviewAsked();
      yield* withPersonFrom(fake, Option.some("review-asked-again"));
      removedBy(fake, STRANGER);

      expect(yield* flowTriggered(fake, reReview)).toEqual([]);
      expect(yield* sourceFound(fake, "review.requestedAgain")).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("address-review: the changes asked aren't addressed", () =>
    Effect.gen(function* () {
      const fake = changesOnHead();
      yield* withPersonFrom(fake, Option.some("changes-asked"));
      removedBy(fake, STRANGER);

      expect(yield* flowTriggered(fake, addressReview)).toEqual([]);
      expect(yield* sourceFound(fake, "review.changesRequested")).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("resolve-conflicts: its conflict isn't resolved", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      yield* withPersonFrom(fake, Option.some("review-asked"));
      removedBy(fake, STRANGER);

      expect(yield* flowTriggered(fake, resolveConflicts)).toEqual([]);
      expect(yield* sourceFound(fake, "pr.conflicting")).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
    }),
  );
});

describe("the needs-human label added by hand, with no record, holds nothing", () => {
  effect("review: a first review", () =>
    Effect.gen(function* () {
      const fake = reviewAsked();
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);

      expect(keysOf(yield* flowTriggered(fake, review))).toEqual([PR_ITEM]);
      expect(keysOf(yield* sourceFound(fake, "review.requested"))).toEqual([PR_ITEM]);
    }),
  );

  effect("re-review: a review again", () =>
    Effect.gen(function* () {
      const fake = reviewAsked();
      fake.recordPhase(PR_ITEM, "review-asked-again");
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);

      expect(yield* flowTriggered(fake, reReview)).toHaveLength(1);
      expect(yield* sourceFound(fake, "review.requestedAgain")).toHaveLength(1);
    }),
  );

  effect("address-review: the changes asked", () =>
    Effect.gen(function* () {
      const fake = changesOnHead();
      fake.recordPhase(PR_ITEM, "changes-asked");
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);

      expect(yield* flowTriggered(fake, addressReview)).toHaveLength(1);
      expect(yield* sourceFound(fake, "review.changesRequested")).toHaveLength(1);
    }),
  );

  effect("resolve-conflicts: its conflict", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.recordPhase(PR_ITEM, "review-asked");
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      const key = `pr-${PULL}-${HEAD.slice(0, 7)}`;

      expect(keysOf(yield* flowTriggered(fake, resolveConflicts))).toEqual([key]);
      expect(keysOf(yield* sourceFound(fake, "pr.conflicting"))).toEqual([key]);
    }),
  );

  effect("resolve-conflicts: a wait on its merge's CI", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.merge.state = "clean";
      fake.recordPhase(PR_ITEM, Phases.conflictCi(1), {
        data: { since: "2026-11-22T00:00:00.000Z" },
      });
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);

      const found = yield* triggered(fake, Conflict.parkedOnCi);

      expect(found).toHaveLength(1);
    }),
  );
});

describe("a pull request handed back is taken up from its handed-back { from } record", () => {
  effect("from changes-asked: address-review answers the changes asked on the head", () =>
    Effect.gen(function* () {
      const fake = changesOnHead();
      handedBackFrom(fake, Option.some("changes-asked"));

      const found = yield* flowTriggered(fake, addressReview);

      expect(fake.phases()[PR_ITEM]).toBe("changes-asked");
      expect(keysOf(found)).toEqual([Phases.keyFor(PR_ITEM, recordOf(fake))]);
      expect(found.map((work) => Option.fromUndefinedOr(work.held))).toEqual([Option.none()]);
    }),
  );

  effect("from changes-asked, nothing asked on the head since: nothing to address", () =>
    Effect.gen(function* () {
      const fake = changesOnHead();
      fake.submitted.length = 0;
      fake.submitted.push({ author: REVIEWER, state: "CHANGES_REQUESTED", commitSha: "old0000" });
      handedBackFrom(fake, Option.some("changes-asked"));

      expect(yield* flowTriggered(fake, addressReview)).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("from changes-asked, not a first review", () =>
    Effect.gen(function* () {
      const fake = reviewAsked();
      handedBackFrom(fake, Option.some("changes-asked"));

      expect(yield* flowTriggered(fake, review)).toEqual([]);
    }),
  );

  effect("from review-asked-again: re-review reviews it again", () =>
    Effect.gen(function* () {
      const fake = reviewAsked();
      handedBackFrom(fake, Option.some("review-asked-again"));

      expect(yield* flowTriggered(fake, review)).toEqual([]);

      const found = yield* flowTriggered(fake, reReview);

      expect(fake.phases()[PR_ITEM]).toBe("review-asked-again");
      expect(found.map((work) => Option.fromUndefinedOr(work.held))).toEqual([Option.none()]);
      expect(found).toHaveLength(1);
    }),
  );

  effect("from review-asked-again, changes asked on the head: not address-review's", () =>
    Effect.gen(function* () {
      const fake = changesOnHead();
      handedBackFrom(fake, Option.some("review-asked-again"));

      expect(yield* flowTriggered(fake, addressReview)).toEqual([]);
      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
    }),
  );

  for (const from of [Option.some("review-asked"), Option.some("approved"), Option.none()]) {
    const named = Option.getOrElse(from, () => "no phase");

    effect(`from ${named}: review's first review`, () =>
      Effect.gen(function* () {
        const fake = reviewAsked();
        handedBackFrom(fake, from);

        const found = yield* flowTriggered(fake, review);

        expect(keysOf(found)).toEqual([PR_ITEM]);
        expect(found.map((work) => Option.fromUndefinedOr(work.held))).toEqual([Option.none()]);
        expect(yield* flowTriggered(fake, reReview)).toEqual([]);
        expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
      }),
    );
  }

  effect("each record it moves on from passes the ledger's check", () =>
    Effect.gen(function* () {
      const changes = changesOnHead();
      handedBackFrom(changes, Option.some("changes-asked"));
      yield* flowTriggered(changes, addressReview);

      const again = reviewAsked();
      handedBackFrom(again, Option.some("review-asked-again"));
      yield* flowTriggered(again, reReview);

      for (const fake of [changes, again]) {
        const found = recordOf(fake);
        expect<Option.Option<string>>(found.from).toEqual(Option.some(HANDED_BACK));
        expect(passes(found)).toBe(true);
      }
    }),
  );
});
