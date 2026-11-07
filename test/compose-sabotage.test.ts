// Whether the comparison of a document's flow with its recipe can fail: each
// of these breaks a generated flow in one way a person or a bug could, and the
// comparison must see it. A comparison that passes everything says nothing.

import { type Flow } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

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
  EPIC_DOCUMENT,
  generated,
  HUMAN_INITIATED_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  loadSource,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
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
  HUMAN_INITIATED_SCENARIOS,
  HUMAN_INITIATED_WORK_ITEM,
  IMPLEMENT_SCENARIOS,
  IMPLEMENT_WORK_ITEM,
  observe,
  PLAN_SCENARIOS,
  PLAN_WORK_ITEM,
  POST_MERGE_SCENARIOS,
  POST_MERGE_WORK_ITEM,
  RE_REVIEW_SCENARIOS,
  RE_REVIEW_WORK_ITEM,
  RESOLVE_CONFLICTS_LAYER_SCENARIOS,
  RESOLVE_CONFLICTS_LAYER_WORK_ITEM,
  RESOLVE_CONFLICTS_SCENARIOS,
  RESOLVE_CONFLICTS_WORK_ITEM,
  REVIEW_SCENARIOS,
  REVIEW_WORK_ITEM,
  type Scenario,
  stageElsewhere,
  stageSkipping,
  throughStage,
} from "./compose-scenarios.ts";
import { effect } from "./effect-test.ts";

type Target = {
  readonly name: string;
  readonly recipe: Flow;
  readonly source: string;
  readonly work: Parameters<typeof observe>[3];
  readonly scenarios: ReadonlyArray<Scenario>;
};

const targets = {
  implement: {
    name: "implement",
    recipe: implement,
    source: generated(documentOf(IMPLEMENT_DOCUMENT)),
    work: IMPLEMENT_WORK_ITEM,
    scenarios: IMPLEMENT_SCENARIOS,
  },
  review: {
    name: "review",
    recipe: review,
    source: generated(documentOf(REVIEW_DOCUMENT)),
    work: REVIEW_WORK_ITEM,
    scenarios: REVIEW_SCENARIOS,
  },
  reReview: {
    name: "re-review",
    recipe: reReview,
    source: generated(documentOf(RE_REVIEW_DOCUMENT)),
    work: RE_REVIEW_WORK_ITEM,
    scenarios: RE_REVIEW_SCENARIOS,
  },
  addressReview: {
    name: "address-review",
    recipe: addressReview,
    source: generated(documentOf(ADDRESS_REVIEW_DOCUMENT)),
    work: ADDRESS_REVIEW_WORK_ITEM,
    scenarios: ADDRESS_REVIEW_SCENARIOS,
  },
  addressReviewLayer: {
    name: "address-review",
    recipe: addressReview,
    source: generated(documentOf(ADDRESS_REVIEW_DOCUMENT)),
    work: ADDRESS_REVIEW_LAYER_WORK_ITEM,
    scenarios: ADDRESS_REVIEW_LAYER_SCENARIOS,
  },
  resolveConflicts: {
    name: "resolve-conflicts",
    recipe: resolveConflicts,
    source: generated(documentOf(RESOLVE_CONFLICTS_DOCUMENT)),
    work: RESOLVE_CONFLICTS_WORK_ITEM,
    scenarios: RESOLVE_CONFLICTS_SCENARIOS,
  },
  resolveConflictsLayer: {
    name: "resolve-conflicts",
    recipe: resolveConflicts,
    source: generated(documentOf(RESOLVE_CONFLICTS_DOCUMENT)),
    work: RESOLVE_CONFLICTS_LAYER_WORK_ITEM,
    scenarios: RESOLVE_CONFLICTS_LAYER_SCENARIOS,
  },
  postMerge: {
    name: "post-merge",
    recipe: postMerge,
    source: generated(documentOf(POST_MERGE_DOCUMENT)),
    work: POST_MERGE_WORK_ITEM,
    scenarios: POST_MERGE_SCENARIOS,
  },
  humanInitiated: {
    name: "human-initiated",
    recipe: humanInitiated,
    source: generated(documentOf(HUMAN_INITIATED_DOCUMENT)),
    work: HUMAN_INITIATED_WORK_ITEM,
    scenarios: HUMAN_INITIATED_SCENARIOS,
  },
  plan: {
    name: "plan",
    recipe: plan,
    source: generated(documentOf(PLAN_DOCUMENT)),
    work: PLAN_WORK_ITEM,
    scenarios: PLAN_SCENARIOS,
  },
  epic: {
    name: "epic",
    recipe: epic,
    source: generated(documentOf(EPIC_DOCUMENT)),
    work: EPIC_WORK_ITEM,
    scenarios: EPIC_SCENARIOS,
  },
} satisfies Record<string, Target>;

// The step `id`, written out of the flow, or as `standIn` where it was.
const dropping =
  (id: string, standIn = "") =>
  (source: string) =>
    source.replace(new RegExp(`const ${id} = yield\\* [^\\n]*`), standIn);

const sabotaged = (
  title: string,
  target: Target,
  scenarioTitle: string,
  sabotage: (source: string) => string,
) => {
  effect(
    title,
    () =>
      Effect.gen(function* () {
        const source = sabotage(target.source);

        // A sabotage whose text no longer matches would pass by doing nothing.
        expect(source).not.toBe(target.source);

        const [scenario] = target.scenarios.filter((each) => each.title === scenarioTitle);
        const { settings, setup, wake } = scenario;
        const flow = yield* loadSource(source);

        const fromRecipe = yield* observe(
          target.recipe,
          target.name,
          setup,
          target.work,
          wake,
          settings,
        );

        const fromFlow = yield* observe(flow, target.name, setup, target.work, wake, settings);

        expect(fromFlow).not.toEqual(fromRecipe);
      }),
    60_000,
  );
};

describe("the comparison sees an implement flow that", () => {
  const { implement: target } = targets;

  sabotaged(
    "doesn't hand off",
    target,
    "when the work goes for review",
    dropping("done", 'const done = "x";'),
  );

  sabotaged("skips the local gate", target, "when the work goes for review", dropping("gate"));

  sabotaged("doesn't let its claim go", target, "when the work goes for review", (source) =>
    source.replace("{ claims: true }", "{ claims: false }"),
  );

  sabotaged(
    "forgets its pull request when it fails",
    target,
    "when CI is red and stays red",
    (source) => source.replace("failureContext.pr = Option.some(opened.number);", ""),
  );
});

describe("the comparison sees a review flow that", () => {
  const { review: target } = targets;

  sabotaged(
    "never lands",
    target,
    "when it approves a pull request on the automated path",
    dropping("land", 'const land = "x";'),
  );

  sabotaged("takes changes asked for as approval", target, "when it asks for changes", (source) =>
    source.replace('outcomes["changes"]', 'outcomes["approve"]'),
  );
});

describe("the comparison sees a re-review flow that", () => {
  const { reReview: target } = targets;

  sabotaged(
    "reviews afresh when it has a review of its own to resume",
    target,
    "when it approves on the re-review, and a person merges",
    (source) =>
      source.replace(
        'catalogue["review.latestOwn"].outcomes["none"](earlier)',
        'catalogue["review.latestOwn"].outcomes["found"](earlier)',
      ),
  );

  sabotaged(
    "never lands a first review's approval",
    target,
    "when its review carries no session to resume, and a first review merges",
    dropping("land", 'const land = "x";'),
  );

  sabotaged(
    "takes a first review's changes asked for as approval",
    target,
    "when it has no review of its own, and a first review asks for changes",
    (source) =>
      source.replace(
        'catalogue["review.round"].outcomes["changes"]',
        'catalogue["review.round"].outcomes["approve"]',
      ),
  );

  sabotaged(
    "re-reviews past reviewRounds",
    target,
    "when it has had as many re-reviews as reviewRounds allows",
    (source) =>
      source.replace(
        'outcomes["exhausted"](rounds)',
        'outcomes["exhausted"]({ reReviews: 0, limit: 1 })',
      ),
  );

  sabotaged(
    "stops at reviewRounds without telling the pull request",
    target,
    "when it has had as many re-reviews as reviewRounds allows",
    dropping("capped", "const capped = why;"),
  );

  sabotaged(
    "never lands a re-review's approval",
    target,
    "when it approves a pull request on the automated path",
    dropping("landed", 'const landed = "x";'),
  );

  sabotaged(
    "stops on changes asked for again without telling the pull request",
    target,
    "when it still asks for changes",
    dropping("handed", "const handed = open.reason;"),
  );

  sabotaged(
    "takes changes asked for again as approval",
    target,
    "when it still asks for changes",
    (source) =>
      source.replace(
        'catalogue["review.recheck"].outcomes["changes"]',
        'catalogue["review.recheck"].outcomes["approve"]',
      ),
  );
});

describe("the comparison sees an address-review flow that", () => {
  const { addressReview: target, addressReviewLayer: layer } = targets;
  const agrees = "when the author agrees, fixes, and CI is green";

  sabotaged(
    "pushes the fix of a review the author disputes",
    target,
    "when the author disputes the review",
    (source) =>
      source.replace(
        'catalogue["author.consider"].outcomes["decline"](considered)',
        "Option.none()",
      ),
  );

  sabotaged(
    "hands a dispute to a person without its reasons",
    target,
    "when the author disputes the review",
    dropping("replied", 'const replied = "the author disputes review 1; see its reasons above";'),
  );

  sabotaged(
    "stops on a dispute without telling the pull request",
    target,
    "when the author disputes the review",
    dropping("disputed", "const disputed = replied;"),
  );

  sabotaged(
    "goes on when the author has questions",
    target,
    "when the author needs a person to answer the review",
    (source) =>
      source.replace(
        'catalogue["author.address"].outcomes["needs-clarification"](addressed)',
        "Option.none()",
      ),
  );

  sabotaged(
    "stops on the author's questions without telling the pull request",
    target,
    "when the author needs a person to answer the review",
    dropping("asking", "const asking = questions.reason;"),
  );

  sabotaged(
    "pushes changes the author left uncommitted",
    target,
    "when the author leaves its changes uncommitted",
    dropping("changed"),
  );

  sabotaged(
    "pushes without waiting for CI",
    target,
    "when CI is red and stays red",
    dropping("ci"),
  );

  sabotaged(
    "asks the reviewer again without pushing",
    target,
    agrees,
    dropping("pushed", "const pushed = { pushed: addressed.committed };"),
  );

  sabotaged(
    "never asks the reviewer again",
    target,
    agrees,
    dropping("again", 'const again = "x";'),
  );

  sabotaged("asks another persona to review again", target, agrees, (source) =>
    source.replace('"reviewer": trigger.reviewer, "summary"', '"reviewer": "zach", "summary"'),
  );

  sabotaged(
    "answers an epic task's review in a fresh session, not the task's own",
    target,
    "when the pull request is an epic task's, whose own session answers",
    dropping(
      "author",
      "const author = { sessionId: Option.none(), adapter: Option.none(), withPerson: false };",
    ),
  );

  sabotaged(
    "answers outside the session a person worked in",
    target,
    "when a person worked on the pull request with the agent, and the fix touches humanOnlyPaths",
    (source) =>
      source.replace(
        '"session": author, "committed"',
        '"session": { ...author, withPerson: false }, "committed"',
      ),
  );

  sabotaged(
    "checks a layer's push against the repo's base, not the layer below",
    layer,
    "when a layer of a stack is addressed",
    (source) =>
      source.replace(
        '"base": trigger.base, "review": asked, "session": author, "committed"',
        '"base": Option.none(), "review": asked, "session": author, "committed"',
      ),
  );
});

describe("the comparison sees a resolve-conflicts flow that", () => {
  const { resolveConflicts: target, resolveConflictsLayer: layer } = targets;
  const approved = "when it was approved, so its reviewer is asked again";
  const settle = "when only a person can settle the conflict";

  sabotaged("pushes a merge only a person can settle", target, settle, (source) =>
    source.replace(
      'catalogue["conflict.resolve"].outcomes["needs-human"](resolved)',
      "Option.none()",
    ),
  );

  sabotaged(
    "stops on a conflict only a person can settle without telling the pull request",
    target,
    settle,
    dropping("handed", "const handed = stuck.reason;"),
  );

  sabotaged(
    "pushes what a person must settle of the layer below's record",
    target,
    "when only a person can settle what the record of the layer below left",
    (source) =>
      source.replace(
        'catalogue["conflict.resolve"].outcomes["needs-human"](resolved)',
        "Option.none()",
      ),
  );

  sabotaged("skips the local gate", target, approved, dropping("gate"));

  sabotaged(
    "pushes without saying how it resolved the conflicts",
    target,
    approved,
    dropping("said"),
  );

  sabotaged(
    "pushes without waiting for CI",
    target,
    "when CI is red and stays red",
    dropping("ci"),
  );

  sabotaged(
    "fixes red CI outside the session that resolved the conflict",
    target,
    "when CI is red and stays red",
    (source) =>
      source.replace(
        '"base": trigger.base, "session": resolved.session',
        '"base": trigger.base, "session": { sessionId: Option.none(), adapter: Option.none() }',
      ),
  );

  sabotaged(
    "never asks the approver again",
    target,
    approved,
    dropping("again", 'const again = "#7: merged main and resolved its conflicts";'),
  );

  sabotaged(
    "merges the repo's base into a layer of a stack, not the layer below",
    layer,
    "when a layer of a stack conflicts with the layer below",
    (source) =>
      source.replace(
        '"base": trigger.base, "worktree": worktree',
        '"base": "main", "worktree": worktree',
      ),
  );

  sabotaged(
    "checks a layer's push against the repo's base, not the layer below",
    layer,
    "when a layer of a stack conflicts with the layer below",
    (source) => source.replace('"base": trigger.base, "committed"', '"base": "main", "committed"'),
  );
});

describe("the comparison sees an epic flow that", () => {
  const { epic: target } = targets;
  const opens = "when it opens every ready task's pull request and parks";

  sabotaged(
    "doesn't carry a change up its stack",
    target,
    opens,
    dropping("carried", "const carried = { moved: false, stack: state.stack };"),
  );

  sabotaged("never lands", target, "when its layers ship", (source) =>
    source.replace("const landed = ships.value === true ?", "const landed = false ?"),
  );

  sabotaged("posts no status", target, opens, dropping("status"));

  sabotaged(
    "doesn't note what its tasks waited on",
    target,
    opens,
    dropping("noted", "const noted = { tasks: state.tasks };"),
  );

  sabotaged(
    "keeps a task's claim after its questions",
    target,
    "when a task's agent has questions",
    dropping("released"),
  );

  sabotaged(
    "forgets a task's pull request when it fails",
    target,
    "when a task's CI stays red, and it goes to a person",
    (source) => source.replace("failureContext.pr = Option.some(published.pr.number);", ""),
  );
});

describe("the checks of a document that runs a stage see a flow that", () => {
  const source = generated(documentOf(REVIEW_WITH_STAGE_DOCUMENT));

  const [approved] = REVIEW_SCENARIOS.filter(
    (each) => each.title === "when it approves a pull request on the automated path",
  );

  const breaking = <E>(
    title: string,
    sabotage: (source: string) => string,
    check: (
      flow: Flow,
    ) => Effect.Effect<void, E, Effect.Services<ReturnType<typeof stageSkipping>>>,
  ) => {
    effect(
      title,
      () =>
        Effect.gen(function* () {
          const broken = sabotage(source);

          expect(broken).not.toBe(source);

          yield* check(yield* loadSource(broken));
        }),
      60_000,
    );
  };

  breaking(
    "doesn't run its stage",
    dropping("which", "const which = { pr: trigger.pr };"),
    (flow) =>
      Effect.gen(function* () {
        const { first, flow: fromFlow, recipe } = yield* throughStage(flow, review, approved);

        expect({ first, fromFlow }).not.toEqual({ first: "which-pr", fromFlow: recipe });
      }),
  );

  breaking(
    "takes the trigger's pull request instead of its stage's",
    (text) => text.replaceAll('"pr": which.pr', '"pr": trigger.pr'),
    (flow) =>
      Effect.gen(function* () {
        expect((yield* stageElsewhere(flow)).steps).not.toContain("merge-pr-107");
      }),
  );

  breaking(
    "fails the run where its stage skips it",
    (text) => text.replace('"Skip":"skip"', '"Skip":"fail"'),
    (flow) =>
      Effect.gen(function* () {
        expect((yield* stageSkipping(flow)).status).not.toBe("skipped");
      }),
  );
});

describe("the comparison sees a post-merge flow that", () => {
  const { postMerge: target } = targets;
  const green = "when CI on the merge commit is green";
  const red = "when CI on the merge commit is red, so a follow-up goes to implement";
  const fixOfAFollowUp = "when the merge was a follow-up's fix, so the follow-up goes to a person";

  // Each branch taken as though the outcome hadn't come.
  const notTaking = (outcome: string, bound: string) => (source: string) =>
    source.replace(`catalogue["${outcome}"].outcomes["${bound}"]`, "(() => Option.none())");

  sabotaged(
    "doesn't mark the pull request watched",
    target,
    green,
    dropping("watching", "const watching = void 0;"),
  );

  sabotaged("goes on past green CI", target, green, notTaking("merged.awaitCi", "green"));

  sabotaged(
    "goes on past a merge commit with no CI",
    target,
    "when no CI runs on the merge commit within the grace",
    notTaking("merged.awaitCi", "none"),
  );

  sabotaged(
    "skips a run whose CI stays pending, rather than leaving it to a person",
    target,
    "when CI on the merge commit stays pending past ciTimeout",
    (source) =>
      source.replace(
        /(catalogue\["merged\.awaitCi"\]\.run\(\{[^}]*\})\)/,
        '$1, { NeedsHuman: "skip" })',
      ),
  );

  sabotaged("ignores red CI", target, red, notTaking("merged.awaitCi", "red"));

  sabotaged(
    "files a follow-up when CI was already red before the merge",
    target,
    "when CI was already red before the merge",
    notTaking("merged.redBefore", "already-red"),
  );

  sabotaged(
    "files a follow-up's failed fix for implement, not for a person",
    target,
    fixOfAFollowUp,
    dropping("closes", "const closes = { fixed: Option.none() };"),
  );

  sabotaged(
    "files a follow-up without the failed runs' logs",
    target,
    red,
    dropping("failed", "const failed = { details: [] };"),
  );

  sabotaged("files no follow-up", target, red, dropping("filed", "const filed = 100;"));

  sabotaged(
    "doesn't link the follow-up from the merged pull request",
    target,
    red,
    dropping("linked", 'const linked = "#7: CI on merge56 is red; filed #100 to fix it";'),
  );
});

describe("the comparison sees a human-initiated flow that", () => {
  const { humanInitiated: target } = targets;
  const done = "when the person and the agent are done";
  const red = "when CI is red and stays red";

  // A block's run given a failure table of the sabotage's own.
  const overriding = (block: string, failures: string) => (source: string) =>
    source.replace(
      new RegExp(`(catalogue\\["${block.replaceAll(".", "\\.")}"\\]\\.run\\(\\{[^}]*\\})\\)`),
      `$1, ${failures})`,
    );

  sabotaged("doesn't hand off", target, done, dropping("handed", 'const handed = "x";'));

  sabotaged("skips the local gate", target, "when the local gate keeps failing", dropping("gate"));

  sabotaged("doesn't let its claim go", target, done, (source) =>
    source.replace("{ claims: true }", "{ claims: false }"),
  );

  sabotaged("doesn't wait for CI", target, red, dropping("ci"));

  sabotaged("forgets its pull request when it fails", target, red, (source) =>
    source.replace("failureContext.pr = Option.some(opened.number);", ""),
  );

  sabotaged(
    "hands a failure before the session to a person, rather than failing",
    target,
    "when the worktree's install fails",
    (source) => source.replace(', {"StepFailed":"fail"}', ""),
  );

  sabotaged(
    "hands a session the person closed to a person, rather than failing",
    target,
    "when the person closes the session before open-pr",
    overriding("hybrid.workWithPerson", '{ StepFailed: "person" }'),
  );

  sabotaged(
    "fails, rather than skipping, on an issue another run holds",
    target,
    "when another run holds the claim",
    overriding("hybrid.claim", '{ Skip: "fail" }'),
  );

  sabotaged(
    "stops, rather than telling a person, when nothing was committed",
    target,
    "when nothing was committed before open-pr",
    overriding("hybrid.push", '{ NeedsHuman: "told" }'),
  );

  sabotaged(
    "stops, rather than telling a person, when the push is rejected",
    target,
    "when the remote rejects the push",
    overriding("hybrid.push", '{ PushRejected: "told" }'),
  );
});

describe("the comparison sees a plan flow that", () => {
  const { plan: target } = targets;
  const approved = "when a person approves the plan";
  const changes = "when a person asks for changes, and approves the plan drafted again";
  const questions = "when the agent has questions";

  // Each branch taken as though the outcome hadn't come.
  const notTaking = (block: string, outcome: string) => (source: string) =>
    source.replace(`catalogue["${block}"].outcomes["${outcome}"]`, "(() => Option.none())");

  // A block's run given a failure table of the sabotage's own.
  const overriding = (block: string, failures: string) => (source: string) =>
    source.replace(
      new RegExp(`(catalogue\\["${block.replaceAll(".", "\\.")}"\\]\\.run\\(\\{[^}]*\\})\\)`),
      `$1, ${failures})`,
    );

  sabotaged(
    "makes no issues once approved",
    target,
    approved,
    dropping("created", "const created = { created: [] };"),
  );

  sabotaged(
    "doesn't make the spec an epic",
    target,
    approved,
    dropping("epic", 'const epic = "#42: an epic of 4 sub-issues";'),
  );

  sabotaged(
    "leaves the plan's checkout once approved",
    target,
    approved,
    dropping("cleaned", "const cleaned = void 0;"),
  );

  sabotaged("doesn't let its claim go", target, approved, (source) =>
    source.replace("{ claims: true }", "{ claims: false }"),
  );

  sabotaged("takes changes asked for as approval", target, changes, (source) =>
    source.replace('outcomes["changes"]', 'outcomes["approved"]'),
  );

  sabotaged("drafts again without what the person asked to change", target, changes, (source) =>
    source.replace('"changes": asked.changes', '"changes": Option.none()'),
  );

  sabotaged("posts a plan it has questions about", target, questions, (source) =>
    notTaking("plan.draft", "needs-clarification")(source),
  );

  sabotaged(
    "leaves the plan's checkout when the agent has questions",
    target,
    questions,
    dropping("cleared", "const cleared = void 0;"),
  );

  sabotaged(
    "stops, rather than telling a person, when the plan keeps failing its checks",
    target,
    "when the plan still fails its checks after planRounds attempts to fix it",
    overriding("plan.draft", '{ NeedsHuman: "told" }'),
  );

  sabotaged(
    "fails, rather than telling a person, when the agent's answer isn't a plan",
    target,
    "when the agent's answer isn't a plan",
    overriding("plan.draft", '{ StepFailed: "fail" }'),
  );

  sabotaged(
    "hands a claim that fails to a person, rather than failing",
    target,
    "when the base branch is gone",
    (source) => source.replace(', {"StepFailed":"fail"}', ""),
  );

  sabotaged(
    "fails, rather than skipping, on a spec another run holds",
    target,
    "when another run holds the claim",
    overriding("issue.claim", '{ Skip: "fail" }'),
  );
});
