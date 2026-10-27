// Turns a spec into a body of work: claim the oldest issue labelled
// auto:plan, let the agent read it and the code in a read-only checkout and
// propose the tasks it splits into and which blocks which, check the plan,
// post it on the issue and wait for a person. Approved (auto:plan-approved),
// each task becomes a sub-issue of the spec, linked to the tasks that block
// it and labelled by its kind, and the spec becomes an epic (auto:epic). A
// comment asking for changes drafts it again. The agent answers with data
// only: the repo's other flows pick up its tasks by their labels.
//
// This file is chernabog's plan recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("claim", "draft-plan-1") are the keys a
// run in flight resumes by, so renaming one restarts that step.

import {
  defineFlow,
  GitHub,
  Implement,
  NeedsHuman,
  Plan,
  reportAs,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

// How long a posted plan waits for a person before the run hands it back.
const ANSWER_WITHIN = "14 days";

// Specs labelled auto:plan, oldest first, as work to start; with a board,
// only those whose Status is its readyStatus. Then specs whose posted plan a
// person has answered, which wake the run waiting on it.
const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const queued = yield* github.queuedIssuesLabelled(Plan.LABELS.plan);
  const answered = yield* Plan.answers;

  return [
    ...queued.map((issue) => Implement.issueItem(issue, Option.some(Plan.LABELS.plan))),
    ...answered,
  ];
}).pipe(reportAs("trigger"));

// Drafts, checks and proposes the plan, and waits for a person's answer,
// round after round until they approve it. Returns the run's summary, or,
// for a spec that needs answers first, the agent's draft with its questions.
const planUntilApproved = (spec: number) =>
  Effect.gen(function* () {
    let changes = Option.none<string>();

    for (let round = 1; ; round++) {
      const draft = yield* Plan.checkedDraft(spec, round, changes);

      if (draft.status === "needs-clarification") {
        return draft;
      }

      const plan = yield* Plan.propose(spec, round, draft);
      const answer = yield* Plan.awaitAnswer(round, ANSWER_WITHIN);

      if (answer === "approved") {
        const created = yield* Plan.create(spec, plan);

        return yield* Plan.becomeEpic(spec, plan, created);
      }

      if (answer === "timeout") {
        return yield* new NeedsHuman({
          reason: `nobody answered the plan within ${ANSWER_WITHIN}`,
        });
      }

      changes = Option.some(yield* Plan.changesAsked(spec, round));
    }
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const spec = yield* Implement.issueOf(item);
    yield* Implement.claim(spec, yield* Implement.queuedBy(item));

    // Each ending removes the plan's checkout first.
    const toPerson = (reason: string) =>
      Plan.doneDrafting(spec).pipe(
        Effect.andThen(Plan.handToHuman(spec, reason)),
        Effect.flatMap(Implement.endForPerson),
      );

    const outcome = yield* planUntilApproved(spec).pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        // Any other failure once the spec is claimed hands it to a person,
        // rather than leaving it claimed with nobody working on it.
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
      }),
    );

    yield* Plan.doneDrafting(spec);

    if (Predicate.isString(outcome)) {
      return outcome;
    }

    return yield* Plan.askForClarification(spec, outcome).pipe(
      Effect.flatMap(Implement.endForPerson),
    );
  }).pipe(
    // An issue deleted or transferred under the run leaves nothing to do.
    Effect.catchTag("NotFound", (gone) => Effect.fail(new Skip({ reason: gone.message }))),
  );

export default defineFlow({
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  labels: Plan.flowLabels,
  workflow,
});
