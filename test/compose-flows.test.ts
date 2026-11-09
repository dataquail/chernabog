// A generated flow must behave as the recipe it stands in for: each scenario
// runs through the engine twice, once as the recipe and once as its document's
// flow, and what each left must match.

import {
  DEFAULT_LABELS,
  type Flow,
  isManual,
  labelsOf,
  ownerMarker,
  Plan,
  Settings,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import addressReview from "../packages/recipes/flows/address-review.ts";
import epic from "../packages/recipes/flows/epic.ts";
import humanInitiated from "../packages/recipes/flows/human-initiated.ts";
import implement from "../packages/recipes/flows/implement.ts";
import plan from "../packages/recipes/flows/plan.ts";
import postMerge from "../packages/recipes/flows/post-merge.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import resolveConflicts from "../packages/recipes/flows/resolve-conflicts.ts";
import review from "../packages/recipes/flows/review.ts";
import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  DRAFT_DOCUMENT,
  EPIC_DOCUMENT,
  HUMAN_INITIATED_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  IMPLEMENT_READY_DOCUMENT,
  loadFlow,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  READY_DOCUMENT,
  READY_MESSAGE,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
  REVIEW_WITH_STAGE_DOCUMENT,
} from "./compose-harness.ts";
import {
  ADDRESS_REVIEW_LAYER_SCENARIOS,
  ADDRESS_REVIEW_LAYER_WORK_ITEM,
  ADDRESS_REVIEW_SCENARIOS,
  ADDRESS_REVIEW_WORK_ITEM,
  EPIC_SCENARIOS,
  EPIC_WORK_ITEM,
  type FlowInput,
  HUMAN_INITIATED_SCENARIOS,
  HUMAN_INITIATED_WORK_ITEM,
  IMPLEMENT_SCENARIOS,
  IMPLEMENT_WORK_ITEM,
  observe,
  PLAN_SCENARIOS,
  PLAN_WORK_ITEM,
  POST_MERGE_SCENARIOS,
  POST_MERGE_WORK_ITEM,
  queued,
  RE_REVIEW_SCENARIOS,
  RE_REVIEW_WORK_ITEM,
  RESOLVE_CONFLICTS_LAYER_SCENARIOS,
  RESOLVE_CONFLICTS_LAYER_WORK_ITEM,
  RESOLVE_CONFLICTS_SCENARIOS,
  RESOLVE_CONFLICTS_WORK_ITEM,
  REVIEW_SCENARIOS,
  REVIEW_WORK_ITEM,
  reviewAsked,
  type Scenario,
  stageElsewhere,
  stageSkipping,
  throughStage,
} from "./compose-scenarios.ts";
import { effect } from "./effect-test.ts";
import { type Fake, flowTriggered, HEAD, ISSUE, makeFake, PULL } from "./sdk-fakes.ts";

const composedImplement = loadFlow(documentOf(IMPLEMENT_DOCUMENT));

const composedReview = loadFlow(documentOf(REVIEW_DOCUMENT));

const composedEpic = loadFlow(documentOf(EPIC_DOCUMENT));

const composedReReview = loadFlow(documentOf(RE_REVIEW_DOCUMENT));

const composedAddressReview = loadFlow(documentOf(ADDRESS_REVIEW_DOCUMENT));

const composedResolveConflicts = loadFlow(documentOf(RESOLVE_CONFLICTS_DOCUMENT));

const composedPostMerge = loadFlow(documentOf(POST_MERGE_DOCUMENT));

const composedHumanInitiated = loadFlow(documentOf(HUMAN_INITIATED_DOCUMENT));

const composedPlan = loadFlow(documentOf(PLAN_DOCUMENT));

const runsAsTheRecipe = <E, R>(
  name: string,
  recipe: Flow,
  loading: Effect.Effect<Flow, E, R>,
  work: WorkItem,
  scenario: Scenario,
) =>
  Effect.gen(function* () {
    const composed = yield* loading;
    const { did, ends, settings, setup, wake } = scenario;
    const fromRecipe = yield* observe(recipe, name, setup, work, wake, settings);
    const fromDocument = yield* observe(composed, name, setup, work, wake, settings);

    expect(fromRecipe.status).toBe(ends);
    expect(fromDocument).toEqual(fromRecipe);
    did(fromRecipe);
  });

describe("the implement document runs as the recipe does", () => {
  for (const scenario of IMPLEMENT_SCENARIOS) {
    effect(
      scenario.title,
      () =>
        runsAsTheRecipe("implement", implement, composedImplement, IMPLEMENT_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("the review document runs as the recipe does", () => {
  for (const scenario of REVIEW_SCENARIOS) {
    effect(
      scenario.title,
      () => runsAsTheRecipe("review", review, composedReview, REVIEW_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("the re-review document runs as the recipe does", () => {
  for (const scenario of RE_REVIEW_SCENARIOS) {
    effect(
      scenario.title,
      () => runsAsTheRecipe("re-review", reReview, composedReReview, RE_REVIEW_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("the address-review document runs as the recipe does", () => {
  for (const scenario of ADDRESS_REVIEW_SCENARIOS) {
    effect(
      scenario.title,
      () =>
        runsAsTheRecipe(
          "address-review",
          addressReview,
          composedAddressReview,
          ADDRESS_REVIEW_WORK_ITEM,
          scenario,
        ),
      60_000,
    );
  }

  for (const scenario of ADDRESS_REVIEW_LAYER_SCENARIOS) {
    effect(
      scenario.title,
      () =>
        runsAsTheRecipe(
          "address-review",
          addressReview,
          composedAddressReview,
          ADDRESS_REVIEW_LAYER_WORK_ITEM,
          scenario,
        ),
      60_000,
    );
  }
});

describe("the resolve-conflicts document runs as the recipe does", () => {
  for (const [scenarios, work] of [
    [RESOLVE_CONFLICTS_SCENARIOS, RESOLVE_CONFLICTS_WORK_ITEM],
    [RESOLVE_CONFLICTS_LAYER_SCENARIOS, RESOLVE_CONFLICTS_LAYER_WORK_ITEM],
  ] as const) {
    for (const scenario of scenarios) {
      effect(
        scenario.title,
        () =>
          runsAsTheRecipe(
            "resolve-conflicts",
            resolveConflicts,
            composedResolveConflicts,
            work,
            scenario,
          ),
        60_000,
      );
    }
  }
});

describe("the post-merge document runs as the recipe does", () => {
  for (const scenario of POST_MERGE_SCENARIOS) {
    effect(
      scenario.title,
      () =>
        runsAsTheRecipe("post-merge", postMerge, composedPostMerge, POST_MERGE_WORK_ITEM, scenario),
      60_000,
    );
  }
});

describe("the human-initiated document runs as the recipe does", () => {
  for (const scenario of HUMAN_INITIATED_SCENARIOS) {
    effect(
      scenario.title,
      () =>
        runsAsTheRecipe(
          "human-initiated",
          humanInitiated,
          composedHumanInitiated,
          HUMAN_INITIATED_WORK_ITEM,
          scenario,
        ),
      60_000,
    );
  }
});

describe("the plan document runs as the recipe does", () => {
  for (const scenario of PLAN_SCENARIOS) {
    effect(
      scenario.title,
      () => runsAsTheRecipe("plan", plan, composedPlan, PLAN_WORK_ITEM, scenario),
      60_000,
    );
  }
});

// The recipe waits 14 days for a person's answer, which no run here can, so
// the document's own wait is shortened to see where its timeout goes: to a
// person, with the checkout removed and the claim let go, as the recipe's does.
describe("the plan document's wait for a person", () => {
  effect(
    "hands the spec to a person once nobody answers within its time",
    () =>
      Effect.gen(function* () {
        const document = documentOf(PLAN_DOCUMENT.replace("within: 14 days", "within: 0 days"));
        const [approved] = PLAN_SCENARIOS;

        const observed = yield* observe(
          yield* loadFlow(document),
          "plan",
          approved.setup,
          PLAN_WORK_ITEM,
        );

        expect(observed.status).toBe("needs-human");
        expect(observed.summary).toBe(
          `#${ISSUE} needs a person: nobody answered the plan within 0 days`,
        );
        expect(observed.issueLabels).toEqual([DEFAULT_LABELS.needsHuman]);
        expect(observed.steps).toContain("propose-plan-1");
        expect(observed.steps).toContain(`clean-up-plan-issue-${ISSUE}`);
        expect(observed.steps).toContain("needs-human");
        expect(observed.steps).not.toContain("create-issues");
        expect(observed.comments.at(-1)).toContain(
          "Chernabog stopped planning and needs a person: nobody answered the plan within 0 days",
        );
      }),
    60_000,
  );
});

describe("the epic document runs as the recipe does", () => {
  for (const scenario of EPIC_SCENARIOS) {
    effect(
      scenario.title,
      () => runsAsTheRecipe("epic", epic, composedEpic, EPIC_WORK_ITEM, scenario),
      60_000,
    );
  }
});

// No recipe opens a draft, so the draft document's run is the implement
// recipe's, but for what a draft changes: the pull request opens as a draft,
// nobody in the pool is asked to review it, and the issue says a person marks
// it ready. The step names are the recipe's but for the review request, so a
// run in flight resumes by them.
describe("a document that opens its pull request as a draft", () => {
  const composedDraft = loadFlow(documentOf(DRAFT_DOCUMENT));

  effect(
    "opens it as a draft, hands it off, and asks nobody to review it",
    () =>
      Effect.gen(function* () {
        const made: Array<Fake> = [];

        const setup = () => {
          const fake = queued();
          made.push(fake);

          return fake;
        };

        const fromRecipe = yield* observe(implement, "implement", setup, IMPLEMENT_WORK_ITEM);

        const fromDocument = yield* observe(
          yield* composedDraft,
          "implement",
          setup,
          IMPLEMENT_WORK_ITEM,
        );

        const [recipeFake, documentFake] = made;

        expect(fromDocument.status).toBe("done");
        // The recipe's steps, but for the review it asks for.
        expect(fromRecipe.steps).toContain(`request-review-${PULL}`);
        expect(fromDocument.steps).toEqual(
          fromRecipe.steps.filter((step) => step !== `request-review-${PULL}`),
        );
        expect(fromDocument.steps).toContain("open-pull-request");
        expect(fromDocument.steps).toContain("hand-off");
        expect(fromDocument.opened).toBe(true);
        expect(fromDocument.subjects).toEqual(fromRecipe.subjects);
        expect(fromDocument.pushes).toEqual(fromRecipe.pushes);

        expect(recipeFake.authored.draft).toBe(false);
        expect(documentFake.authored.draft).toBe(true);
        expect(fromRecipe.requested).toBe(1);
        expect(fromDocument.requested).toBe(0);
        expect(fromDocument.pullLabels).toEqual([]);

        expect(documentFake.pullText.body).toContain("Opened by Chernabog as a draft");
        expect(fromDocument.summary).toBe(
          `#${ISSUE}: https://github.com/dataquail/demo/pull/${PULL} is a draft, for a person to mark ready`,
        );
        expect(fromDocument.comments.at(-1)).toContain(
          `Draft pull request opened: https://github.com/dataquail/demo/pull/${PULL}`,
        );
        expect(fromRecipe.comments.at(-1)).toContain("Pull request ready for review");
      }),
    60_000,
  );
});

// No recipe gives an approved pull request to a person as a success, so the
// document's run is the review recipe's, but for what that changes: where the
// recipe's pr.land leaves an approved pull request for a person to merge, the
// document labels it for a person, says what they do next, and ends done. It
// never merges, even one on the automated path.
describe("a review document that gives the approved pull request to a person", () => {
  const composedReady = loadFlow(documentOf(READY_DOCUMENT));
  const READY = "auto:ready-for-person";
  const SHIPS = `ships-pr-${PULL}`;
  const GIVEN = `ready-for-person-pr-${PULL}`;

  const bothRun = (setup: () => Fake, settings: FlowInput = {}) =>
    Effect.gen(function* () {
      const fromRecipe = yield* observe(
        review,
        "review",
        setup,
        REVIEW_WORK_ITEM,
        void 0,
        settings,
      );

      const fromDocument = yield* observe(
        yield* composedReady,
        "review",
        setup,
        REVIEW_WORK_ITEM,
        void 0,
        settings,
      );

      return { fromDocument, fromRecipe };
    });

  effect(
    "labels it, tells the person what to do, and ends done",
    () =>
      Effect.gen(function* () {
        const { fromDocument, fromRecipe } = yield* bothRun(() => reviewAsked("approve"));

        expect(fromRecipe.status).toBe("done");
        expect(fromDocument.status).toBe("done");
        // The recipe's steps, but for its merge's, and the hand-over's in their place.
        expect(fromRecipe.steps).toContain(SHIPS);
        expect(fromDocument.steps).toContain(GIVEN);
        expect(fromDocument.steps.filter((step) => step !== GIVEN)).toEqual(
          fromRecipe.steps.filter((step) => step !== SHIPS),
        );
        expect(fromDocument.reviews).toEqual(fromRecipe.reviews);
        expect(fromDocument.submitted).toEqual(fromRecipe.submitted);

        expect(fromRecipe.pullLabels).not.toContain(READY);
        expect(fromDocument.pullLabels).toEqual([...fromRecipe.pullLabels, READY]);
        expect(fromDocument.pullLabels).not.toContain(DEFAULT_LABELS.needsHuman);

        expect(fromDocument.comments).toEqual([...fromRecipe.comments, READY_MESSAGE]);
        expect(fromDocument.merges).toEqual([]);
        expect(fromDocument.summary).toBe(`#${PULL}: labelled ${READY}; ${READY_MESSAGE}`);
      }),
    60_000,
  );

  effect(
    "never merges, even a pull request on the automated path",
    () =>
      Effect.gen(function* () {
        const { fromDocument, fromRecipe } = yield* bothRun(() =>
          reviewAsked("approve", [DEFAULT_LABELS.ship]),
        );

        expect(fromRecipe.merges).not.toEqual([]);
        expect(fromDocument.merges).toEqual([]);
        expect(fromDocument.status).toBe("done");
        expect(fromDocument.pullLabels).toEqual([DEFAULT_LABELS.ship, READY]);
      }),
    60_000,
  );

  effect(
    "labels it by the name the flow's settings give",
    () =>
      Effect.gen(function* () {
        const { fromDocument } = yield* bothRun(() => reviewAsked("approve"), {
          labels: { readyForPerson: "ready-to-merge" },
        });

        expect(fromDocument.status).toBe("done");
        expect(fromDocument.pullLabels).toEqual(["ready-to-merge"]);
      }),
    60_000,
  );

  effect(
    "runs as the recipe does when the review asks for changes",
    () =>
      Effect.gen(function* () {
        const { fromDocument, fromRecipe } = yield* bothRun(() => reviewAsked("request-changes"));

        expect(fromRecipe.status).toBe("done");
        expect(fromDocument).toEqual(fromRecipe);
      }),
    60_000,
  );

  // `chernabog labels` creates what the flow declares.
  const declaring = (flow: Flow, settings: FlowInput) =>
    labelsOf(flow).pipe(
      Effect.provideService(Settings.FlowSettings, { input: settings }),
      Effect.provide(makeFake("approve").services),
    );

  effect("declares its label, so chernabog labels creates it", () =>
    Effect.gen(function* () {
      const recipe = yield* declaring(review, {});
      const declared = yield* declaring(yield* composedReady, {});
      expect(declared.slice(0, recipe.length)).toEqual([...recipe]);
      expect(declared.slice(recipe.length).map((label) => label.name)).toEqual([READY]);

      const renamed = yield* declaring(yield* composedReady, {
        labels: { readyForPerson: "ready-to-merge" },
      });

      expect(renamed.map((label) => label.name)).toContain("ready-to-merge");
      expect(renamed.map((label) => label.name)).not.toContain(READY);
    }),
  );
});

// pr.readyForPerson is a hand-off: an implement document may give the pull
// request it opens to a person to take on, and end done.
describe("an implement document that gives its pull request to a person", () => {
  const composedImplementReady = loadFlow(documentOf(IMPLEMENT_READY_DOCUMENT));

  effect(
    "opens it, labels it for a person, asks nobody to review it, and ends done",
    () =>
      Effect.gen(function* () {
        const fromDocument = yield* observe(
          yield* composedImplementReady,
          "implement",
          () => queued(),
          IMPLEMENT_WORK_ITEM,
        );

        expect(fromDocument.status).toBe("done");
        expect(fromDocument.opened).toBe(true);
        expect(fromDocument.requested).toBe(0);
        expect(fromDocument.pullLabels).toEqual(["auto:ready-for-person"]);
        expect(fromDocument.comments).toContain("Opened: a person takes it from here.");
      }),
    60_000,
  );
});

const composedWithStage = loadFlow(documentOf(REVIEW_WITH_STAGE_DOCUMENT));

describe("a document that runs a stage", () => {
  // The stage names the pull request the recipe takes from its trigger, so
  // the run is the recipe's, with the stage's step besides.
  for (const scenario of REVIEW_SCENARIOS) {
    effect(
      `runs as the recipe does, ${scenario.title}`,
      () =>
        Effect.gen(function* () {
          const { first, flow, recipe } = yield* throughStage(
            yield* composedWithStage,
            review,
            scenario,
          );

          expect(first).toBe("which-pr");
          expect(flow).toEqual(recipe);
        }),
      60_000,
    );
  }

  effect(
    "gives the stage its input, and the next block its output",
    () =>
      Effect.gen(function* () {
        const { given, steps } = yield* stageElsewhere(yield* composedWithStage);

        // The review and the merge name the pull request they work on.
        expect(given).toEqual([{ pr: PULL }]);
        expect(steps).toContain(`ships-pr-${PULL + 100}`);
        expect(steps).toContain(`merge-pr-${PULL + 100}`);
        expect(steps.filter((step) => step.includes(`-pr-${PULL}`))).toEqual([]);
      }),
    60_000,
  );

  effect(
    "skips the run when the stage skips it, and the document says skip",
    () =>
      Effect.gen(function* () {
        expect(yield* stageSkipping(yield* composedWithStage)).toEqual({
          status: "skipped",
          steps: ["which-pr"],
          reviews: [],
        });
      }),
    60_000,
  );
});

describe("a document's sources find what its recipe's trigger does", () => {
  const found = (flow: Flow, setup: () => Fake) => flowTriggered(setup(), flow);

  const both = () => {
    const fake = queued();
    fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible, DEFAULT_LABELS.ship]);

    return fake;
  };

  const requested = () => {
    const fake = makeFake("approve");
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];

    return fake;
  };

  for (const [title, setup] of [
    ["an eligible issue", () => queued()],
    ["an issue on the automated path", () => queued(DEFAULT_LABELS.ship)],
    ["an issue with both labels", both],
  ] as const) {
    effect(`implement, on ${title}`, () =>
      Effect.gen(function* () {
        const fromRecipe = yield* found(implement, setup);
        expect(fromRecipe).toHaveLength(1);
        expect(yield* found(yield* composedImplement, setup)).toEqual(fromRecipe);
      }),
    );
  }

  effect("review, on a pull request that asks for one", () =>
    Effect.gen(function* () {
      const fromRecipe = yield* found(review, requested);
      expect(fromRecipe).toHaveLength(1);
      expect(yield* found(yield* composedReview, requested)).toEqual(fromRecipe);
    }),
  );

  // Asked again after its review, one item per request, unless a person has it.
  for (const [title, labels, items] of [
    ["re-review, on a pull request that asks again", [], 1],
    ["re-review, on one a person has", [DEFAULT_LABELS.needsHuman], 0],
  ] as const) {
    effect(title, () =>
      Effect.gen(function* () {
        const reviewed = () => {
          const fake = requested();
          fake.submitted.push({
            author: "data-quail",
            state: "CHANGES_REQUESTED",
            commitSha: HEAD,
          });
          fake.setLabels(PULL, [...labels]);

          return fake;
        };

        const fromRecipe = yield* found(reReview, reviewed);
        expect(fromRecipe).toHaveLength(items);
        expect(yield* found(yield* composedReReview, reviewed)).toEqual(fromRecipe);
      }),
    );
  }

  // Its own pull request with changes asked on the head, unless a person has it,
  // or a push or an approval came since.
  for (const [title, change, items] of [
    ["address-review, on its own pull request with changes asked", (_fake: Fake) => void 0, 1],
    [
      "address-review, on one a person has",
      (fake: Fake) => {
        fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      },
      0,
    ],
    [
      "address-review, on one pushed to since",
      (fake: Fake) => {
        fake.git.head = "fix20000000";
      },
      0,
    ],
    [
      "address-review, on one approved since",
      (fake: Fake) => {
        fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: HEAD });
      },
      0,
    ],
  ] as const) {
    effect(title, () =>
      Effect.gen(function* () {
        const asked = () => {
          const fake = makeFake("approve");
          fake.submitted.push({
            author: "data-quail",
            state: "CHANGES_REQUESTED",
            commitSha: HEAD,
          });
          change(fake);

          return fake;
        };

        const fromRecipe = yield* found(addressReview, asked);
        expect(fromRecipe).toHaveLength(items);
        expect(yield* found(yield* composedAddressReview, asked)).toEqual(fromRecipe);
      }),
    );
  }

  // By the pull request's record (#365): the phase it reads, one a person's
  // review or request moves on first, and one GitHub disagrees with, held.
  const recorded = (phase: string, change: (fake: Fake) => void) => () => {
    const fake = makeFake("approve");
    fake.recordPhase(`pr-${PULL}`, phase);
    change(fake);

    return fake;
  };

  const changesOnHead = (fake: Fake) => {
    fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
  };

  const askedOf = (fake: Fake) => {
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];
  };

  for (const [title, recipe, document, setup] of [
    [
      "address-review, on its record of changes asked",
      addressReview,
      composedAddressReview,
      recorded("changes-asked", changesOnHead),
    ],
    [
      "address-review, on a person's review that asks for changes",
      addressReview,
      composedAddressReview,
      recorded("review-asked", changesOnHead),
    ],
    [
      "address-review, on a record of changes asked the head has moved on from",
      addressReview,
      composedAddressReview,
      recorded("changes-asked", (fake) => {
        changesOnHead(fake);
        fake.git.head = "fix20000000";
      }),
    ],
    [
      "review, on its record of a first review asked",
      review,
      composedReview,
      recorded("review-asked", askedOf),
    ],
    [
      "re-review, on a record of a first review this persona has given, as an adopted one's",
      reReview,
      composedReReview,
      recorded("review-asked", (fake) => {
        askedOf(fake);
        fake.submitted.push({ author: "data-quail", state: "COMMENTED", commitSha: HEAD });
      }),
    ],
    [
      "re-review, on its record of a review asked again",
      reReview,
      composedReReview,
      recorded("review-asked-again", (fake) => {
        askedOf(fake);
        changesOnHead(fake);
      }),
    ],
    [
      "re-review, on a person asking again after changes asked",
      reReview,
      composedReReview,
      recorded("changes-asked", (fake) => {
        askedOf(fake);
        changesOnHead(fake);
      }),
    ],
  ] as const) {
    effect(title, () =>
      Effect.gen(function* () {
        const fromRecipe = yield* found(recipe, setup);
        expect(fromRecipe).toHaveLength(1);
        expect(yield* found(yield* document, setup)).toEqual(fromRecipe);
      }),
    );
  }

  // Its own pull request that conflicts with its base, unless a person has it,
  // a run owns it, or GitHub hasn't said yet; the key carries the head.
  for (const [title, change, items] of [
    ["resolve-conflicts, on its own pull request that conflicts", (_fake: Fake) => void 0, 1],
    [
      "resolve-conflicts, on one pushed to since",
      (fake: Fake) => {
        fake.git.head = "fix20000000";
      },
      1,
    ],
    [
      "resolve-conflicts, on a layer of a stack",
      (fake: Fake) => {
        fake.stack.base = "auto/issue-2";
      },
      1,
    ],
    [
      "resolve-conflicts, on one a person has",
      (fake: Fake) => {
        fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      },
      0,
    ],
    [
      "resolve-conflicts, on one a run owns",
      (fake: Fake) => {
        fake.comment(ownerMarker.write({ flow: "implement", runId: "run-1", released: false }));
      },
      0,
    ],
    [
      "resolve-conflicts, on one GitHub hasn't checked yet",
      (fake: Fake) => {
        fake.merge.state = "unknown";
      },
      0,
    ],
    [
      "resolve-conflicts, on one another login wrote",
      (fake: Fake) => {
        fake.people.me = "zach";
      },
      0,
    ],
  ] as const) {
    effect(title, () =>
      Effect.gen(function* () {
        const dirty = () => {
          const fake = makeFake("approve");
          fake.setLabels(PULL, []);
          fake.merge.state = "dirty";
          change(fake);

          return fake;
        };

        const fromRecipe = yield* found(resolveConflicts, dirty);
        expect(fromRecipe).toHaveLength(items);
        expect(yield* found(yield* composedResolveConflicts, dirty)).toEqual(fromRecipe);
      }),
    );
  }

  // Its own pull request that merged into the base branch in the last day, and
  // that no run has watched yet; the key is the pull request's.
  for (const [title, setup, items] of [
    [
      "post-merge, on its own pull request that merged",
      () => {
        const fake = makeFake("approve");
        fake.states.pull = "merged";

        return fake;
      },
      1,
    ],
    [
      "post-merge, on one that closes no issue",
      () => {
        const fake = makeFake("approve");
        fake.states.pull = "merged";
        fake.authored.headRef = "zach/a-change";

        return fake;
      },
      1,
    ],
    ["post-merge, on one still open", () => makeFake("approve"), 0],
    [
      "post-merge, on one a run has watched",
      () => {
        const fake = makeFake("approve");
        fake.states.pull = "merged";
        fake.comment('<!-- chernabog-post-merge-watched {"sha":"merge5678"} -->');

        return fake;
      },
      0,
    ],
    [
      "post-merge, on one another login wrote",
      () => {
        const fake = makeFake("approve");
        fake.states.pull = "merged";
        fake.authored.author = "zach";

        return fake;
      },
      0,
    ],
    [
      "post-merge, on one merged into another branch",
      () => {
        const fake = makeFake("approve");
        fake.states.pull = "merged";
        fake.stack.base = "auto/issue-2";

        return fake;
      },
      0,
    ],
    [
      "post-merge, on one that merged long ago",
      () => {
        const fake = makeFake("approve");
        fake.states.pull = "merged";
        fake.merged.at = "2026-01-01T00:00:00Z";

        return fake;
      },
      0,
    ],
  ] as const) {
    effect(title, () =>
      Effect.gen(function* () {
        const fromRecipe = yield* found(postMerge, setup);
        expect(fromRecipe).toHaveLength(items);
        expect(yield* found(yield* composedPostMerge, setup)).toEqual(fromRecipe);
      }),
    );
  }

  // Specs labelled auto:plan, and those whose posted plan a person answered,
  // which wake the run waiting on it.
  for (const [title, change, items] of [
    ["plan, on a spec labelled auto:plan", (_fake: Fake) => void 0, 1],
    [
      "plan, on a spec whose plan a person approved",
      (fake: Fake) => {
        fake.setLabels(ISSUE, [Plan.LABELS.proposed, Plan.LABELS.approved]);
      },
      1,
    ],
    [
      "plan, on a spec whose plan a person commented on",
      (fake: Fake) => {
        fake.setLabels(ISSUE, [Plan.LABELS.proposed]);
        fake.comment('## Proposed plan\n\n<!-- chernabog-plan {"round":1} -->');
        fake.comment("Split the API in two.", "zach");
      },
      1,
    ],
    [
      "plan, on a spec whose plan nobody has answered",
      (fake: Fake) => {
        fake.setLabels(ISSUE, [Plan.LABELS.proposed]);
        fake.comment('## Proposed plan\n\n<!-- chernabog-plan {"round":1} -->');
      },
      0,
    ],
    [
      "plan, on an issue not labelled auto:plan",
      (fake: Fake) => {
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      },
      0,
    ],
  ] as const) {
    effect(title, () =>
      Effect.gen(function* () {
        const spec = () => {
          const fake = makeFake("approve");
          fake.setLabels(ISSUE, [Plan.LABELS.plan]);
          change(fake);

          return fake;
        };

        const fromRecipe = yield* found(plan, spec);
        expect(fromRecipe).toHaveLength(items);
        expect(yield* found(yield* composedPlan, spec)).toEqual(fromRecipe);
      }),
    );
  }

  // Which label queues an issue doesn't depend on where a document lists it.
  describe("whatever order a document lists the labels in", () => {
    const listing = (labels: ReadonlyArray<"eligible" | "ship">) =>
      loadFlow({
        ...documentOf(IMPLEMENT_DOCUMENT),
        trigger: [{ use: "issues.queued", with: { labels } }],
      });

    const dataOf = (flow: Flow, setup: () => Fake) =>
      found(flow, setup).pipe(Effect.map((items) => items.map((each) => each.data)));

    const SHIPPING = { issue: ISSUE, label: DEFAULT_LABELS.ship };

    effect("an issue on the automated path is queued by its label", () =>
      Effect.gen(function* () {
        const shipping = () => queued(DEFAULT_LABELS.ship);
        expect(yield* dataOf(yield* listing(["ship"]), shipping)).toEqual([SHIPPING]);
        expect(yield* dataOf(yield* listing(["ship", "eligible"]), shipping)).toEqual([SHIPPING]);
      }),
    );

    effect("an eligible issue is queued by no label", () =>
      Effect.gen(function* () {
        const flow = yield* listing(["ship", "eligible"]);
        expect(yield* dataOf(flow, () => queued())).toEqual([{ issue: ISSUE }]);
      }),
    );

    effect(
      "a run of what a ship-only source finds does as the recipe's does",
      () =>
        Effect.gen(function* () {
          const flow = yield* listing(["ship"]);
          const shipping = () => queued(DEFAULT_LABELS.ship);
          const work = Option.getOrThrow(Arr.head(yield* found(flow, shipping)));
          const fromDocument = yield* observe(flow, "implement", shipping, work);
          expect(fromDocument).toEqual(yield* observe(implement, "implement", shipping, work));
          expect(fromDocument.issueLabels).toEqual([]);
          expect(fromDocument.pullLabels).toEqual([DEFAULT_LABELS.ship]);
        }),
      60_000,
    );
  });
});

describe("a document's flow declares what its recipe does", () => {
  const settingsKeys = (flow: Flow) => {
    const { settings } = flow;

    if (Predicate.hasProperty(settings, "fields") && Predicate.isObject(settings.fields)) {
      return Object.keys(settings.fields).toSorted();
    }

    return [];
  };

  const declared = (flow: Flow) => ({
    settings: settingsKeys(flow),
    concurrency: flow.concurrency,
    ownWork: flow.ownWork === true,
    doctor: flow.doctor,
    stillValid: flow.stillValid,
    gate: flow.gate,
  });

  const labelled = (flow: Flow) =>
    labelsOf(flow).pipe(
      Effect.provideService(Settings.FlowSettings, { input: {} }),
      Effect.provide(makeFake("approve").services),
    );

  effect("implement", () =>
    Effect.gen(function* () {
      const composed = yield* composedImplement;
      expect(declared(composed)).toEqual(declared(implement));
      expect(yield* labelled(composed)).toEqual(yield* labelled(implement));
    }),
  );

  effect("epic", () =>
    Effect.gen(function* () {
      const composed = yield* composedEpic;
      expect(declared(composed)).toEqual(declared(epic));
      expect(yield* labelled(composed)).toEqual(yield* labelled(epic));
    }),
  );

  effect("re-review", () =>
    Effect.gen(function* () {
      const composed = yield* composedReReview;
      expect(declared(composed)).toEqual(declared(reReview));
      expect(yield* labelled(composed)).toEqual(yield* labelled(reReview));
    }),
  );

  effect("address-review", () =>
    Effect.gen(function* () {
      const composed = yield* composedAddressReview;
      expect(declared(composed)).toEqual(declared(addressReview));
      expect(yield* labelled(composed)).toEqual(yield* labelled(addressReview));
    }),
  );

  effect("resolve-conflicts", () =>
    Effect.gen(function* () {
      const composed = yield* composedResolveConflicts;
      expect(declared(composed)).toEqual(declared(resolveConflicts));
      expect(yield* labelled(composed)).toEqual(yield* labelled(resolveConflicts));
    }),
  );

  // Its recipe declares no stillValid and no doctor checks, and not as empty ones.
  effect("post-merge", () =>
    Effect.gen(function* () {
      const composed = yield* composedPostMerge;
      expect(declared(composed)).toEqual(declared(postMerge));
      expect(Object.keys(composed).toSorted()).toEqual(Object.keys(postMerge).toSorted());
      expect(yield* labelled(composed)).toEqual(yield* labelled(postMerge));
    }),
  );

  // A person starts it: it has no trigger, finds the issue they name as the
  // recipe does, and declares no concurrency, as its recipe doesn't.
  effect("human-initiated", () =>
    Effect.gen(function* () {
      const composed = yield* composedHumanInitiated;
      expect(declared(composed)).toEqual(declared(humanInitiated));
      expect(Object.keys(composed).toSorted()).toEqual(Object.keys(humanInitiated).toSorted());
      expect(isManual(composed)).toBe(true);
      expect(composed.start).toBe(true);
      expect(composed.item).toBe(humanInitiated.item);
      expect(yield* labelled(composed)).toEqual(yield* labelled(humanInitiated));
    }),
  );

  // Its stillValid is the recipe's own: a spec closed, or claimed by another run.
  effect("plan", () =>
    Effect.gen(function* () {
      const composed = yield* composedPlan;
      expect(declared(composed)).toEqual(declared(plan));
      expect(Object.keys(composed).toSorted()).toEqual(Object.keys(plan).toSorted());
      expect(yield* labelled(composed)).toEqual(yield* labelled(plan));
    }),
  );

  effect("review", () =>
    Effect.gen(function* () {
      const composed = yield* composedReview;
      expect(declared(composed)).toEqual(declared(review));
      expect(yield* labelled(composed)).toEqual(yield* labelled(review));
    }),
  );
});
