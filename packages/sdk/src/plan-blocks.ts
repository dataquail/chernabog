// The plan recipe's blocks. A run claims a spec labelled auto:plan, has the
// agent draft a plan of tasks in a read-only checkout, checks it in code and
// sends it back to be fixed, posts it on the spec and parks until a person
// answers. Approved, each task becomes a sub-issue and the spec an epic;
// changes asked, the next round drafts it again with them.
//
// The checks and their fixes are plan.draft's own, with outcomes, rather than
// logic in a document. What runs only once a run is on its way out (making
// the issues, the epic, removing the checkout, posting questions) is `last`:
// in a repeat it takes no round, so its step names are the recipe's.

import { Claims, GitHub, NeedsHuman, reportAs, type WorkItem } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type Days,
  defineBlock,
  defineSource,
  type FailureContext,
  IssueNumber,
  ToPerson,
} from "./block.ts";
import * as Implement from "./implement.ts";
import { PHASES } from "./phases.ts";
import * as Plan from "./plan.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";

// That a person approved the plan, which only plan.awaitAnswer gives, so no
// document makes a plan's issues before a person has said yes.
export class PlanApproved extends Schema.TaggedClass<
  PlanApproved,
  { readonly brand: "PlanApproved" }
>()("PlanApproved", {}) {}

// What a person asked to change of the last plan, for the next round's draft:
// none in the first round.
export type PlanChanges = Option.Option<string>;

// What a plan's rounds start with, by the name a document uses it by.
export const planLoopStates = {
  "plan.changes": (): PlanChanges => Option.none(),
};

type Scoped<A, E, R> = (context: FailureContext) => Effect.Effect<A, E, R>;

// A spec: an issue to plan. Its failures going to a person remove the plan's
// checkout, label the spec auto:needs-human and say why, as the recipe's do,
// and its claim goes however the run ends; a run parked on its plan keeps it.
export const specSubject = {
  fields: ["issue", "queued"],
  kinds: { issue: "IssueNumber", queued: "how the issue was queued" },
  failureContext: [],
  read: (item: WorkItem) =>
    Effect.gen(function* () {
      return {
        issue: IssueNumber(yield* Implement.issueOf(item)),
        queued: yield* Implement.queuedBy(item),
      };
    }),
  scope: <A, E, R>(
    trigger: { readonly issue: IssueNumber },
    options: { readonly claims: boolean },
    body: Scoped<A, E | ToPerson, R>,
  ) => {
    const handled = Effect.suspend(() => body({ pr: Option.none() })).pipe(
      Effect.catchIf(
        (failure): failure is ToPerson => failure instanceof ToPerson,
        (failure) =>
          Plan.doneDrafting(trigger.issue).pipe(
            Effect.andThen(Plan.handToHuman(trigger.issue, failure.reason)),
            Effect.flatMap(Implement.endForPerson),
          ),
      ),
    );

    if (options.claims) {
      return handled.pipe(Claims.releasing(Claims.issue(trigger.issue)));
    }

    return handled;
  },
  stillValid: Option.some(Plan.stillValid),
};

export const planSources = {
  "plan.queued": defineSource("plan.queued", "spec", () => ({
    trigger: Effect.gen(function* () {
      const queued = yield* (yield* GitHub).queuedIssuesLabelled(Plan.LABELS.plan);

      return yield* Effect.forEach(queued, (issue) =>
        Implement.routed(issue, Implement.issueItem(issue, Option.some(Plan.LABELS.plan))),
      );
    }).pipe(reportAs("trigger")),
    contributes: {
      settings: { ...Routing.Settings.fields, ...Settings.Board.fields },
      labels: Plan.flowLabels,
    },
  })),
};

// What every plan block suits: each reads or writes the spec's plan, whose
// checkout only a spec's scope removes when a person must take over.
const ON_SPEC = ["spec"];

export const planBlocks = {
  "plan.draft": defineBlock({
    name: "plan.draft",
    suits: ON_SPEC,
    about:
      "Has the agent read the spec and the code, in a read-only checkout of the base branch, and propose the tasks it splits into: each a title, a body, a kind (auto for an agent, hybrid for a person with an agent, human for a person) and the tasks that block it. The plan is checked in code: at least one task and at most planNodes, keys that are lowercase letters, digits and dashes, no key twice and none named verify, a known kind, a title, blockers that are tasks, and no cycle. A plan that fails goes back to the agent with what's wrong, up to planRounds times, and then to a person. The agent may answer with questions instead. Given what a person asked to change, it drafts the plan again with that.",
    inputKinds: {
      issue: "IssueNumber: the spec",
      round: "the round",
      changes: "what a person asked to change, from plan.changesAsked: state.changes",
    },
    outputKinds: { draft: "the plan, which passed its checks: for plan.propose" },
    outcomeKinds: { "needs-clarification": "the agent's answer, with its questions" },
    opens: ["remove-checkout"],
    inputs: { issue: "required", round: "required", changes: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly round: number;
      readonly changes: PlanChanges;
    }) =>
      Plan.checkedDraft(input.issue, input.round, input.changes).pipe(
        Effect.map((draft) => ({ draft })),
      ),
    failures: { NeedsHuman: "person", NotFound: "skip", Skip: "skip", StepFailed: "person" },
    outcomes: {
      "needs-clarification": (drafted: { readonly draft: Plan.PlanDraft }) =>
        Option.liftPredicate(drafted.draft, (draft) => draft.status === "needs-clarification"),
    },
    mustRoute: ["needs-clarification"],
    contributes: {
      settings: { ...Settings.Base.fields, ...Settings.Rules.fields, ...Settings.Plans.fields },
    },
  }),

  "plan.propose": defineBlock({
    name: "plan.propose",
    suits: ON_SPEC,
    about:
      "Posts the plan on the spec as a comment: its summary, a Mermaid graph of which task blocks which, each task folded, and how to answer it. It adds a verify task last, for a person, blocked by every other, that checks the work against the spec's acceptance criteria. It labels the spec auto:plan-proposed, waiting on a person.",
    inputKinds: {
      issue: "IssueNumber: the spec",
      round: "the round",
      draft: "the plan, from plan.draft",
    },
    outputKinds: { plan: "the plan as posted, with its verify task: for plan.create" },
    outcomeKinds: {},
    before: ["plan.awaitAnswer"],
    inputs: { issue: "required", round: "required", draft: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly round: number;
      readonly draft: Plan.PlanDraft;
    }) =>
      Plan.propose(input.issue, input.round, input.draft).pipe(Effect.map((plan) => ({ plan }))),
    failures: { NeedsHuman: "person", NotFound: "skip", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "plan.awaitAnswer": defineBlock({
    name: "plan.awaitAnswer",
    suits: ON_SPEC,
    fixed: ["within"],
    about:
      "Parks the run until a person answers the posted plan: approved when the spec carries auto:plan-approved, or changes when a member of the repo comments on it. Nobody answering within `within` goes to a person.",
    inputKinds: { round: "the round", within: 'how long, as "14 days"' },
    outputKinds: "approved or changes-requested",
    outcomeKinds: {
      approved: "an object: with as: approval, approval.approved (PlanApproved), for plan.create",
      changes: "nothing: plan.changesAsked reads what to change",
    },
    inputs: { round: "required", within: "required" },
    run: (input: { readonly round: number; readonly within: Days }) =>
      Effect.gen(function* () {
        const answer = yield* Plan.awaitAnswer(input.round, input.within);

        if (answer === "timeout") {
          return yield* new NeedsHuman({
            reason: `nobody answered the plan within ${input.within}`,
          });
        }

        return answer;
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {
      approved: (answer: string) =>
        Option.liftPredicate({ approved: new PlanApproved({}) }, () => answer === "approved"),
      changes: (answer: string) => Option.liftPredicate({}, () => answer !== "approved"),
    },
    mustRoute: ["approved", "changes"],
    exhaustive: true,
    waits: true,
    records: [{ item: "issue", phase: PHASES.issue.proposed }],
    contributes: {
      wakes: Plan.answers.pipe(reportAs("trigger")),
      wakeReads: [{ item: "issue", phases: [PHASES.issue.proposed] }],
    },
  }),

  "plan.changesAsked": defineBlock({
    name: "plan.changesAsked",
    suits: ON_SPEC,
    about:
      "Reads what a person asked to change of the plan, from the comments of the repo's members since it was posted, and takes auto:plan-proposed off the spec. Its changes go to the next round, with next: { changes: <this step>.changes }.",
    inputKinds: { issue: "IssueNumber: the spec", round: "the round" },
    outputKinds: { changes: "what to change, for the next round's plan.draft" },
    outcomeKinds: {},
    inputs: { issue: "required", round: "required" },
    run: (input: { readonly issue: IssueNumber; readonly round: number }) =>
      Plan.changesAsked(input.issue, input.round).pipe(
        Effect.map((asked) => ({ changes: Option.some(asked) })),
      ),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "plan.create": defineBlock({
    name: "plan.create",
    suits: ON_SPEC,
    about:
      "Makes each task of the approved plan an issue and a sub-issue of the spec, links each to the tasks that block it, and only then labels them by kind (auto:eligible for auto, auto:needs-human for human, none for hybrid), so no flow picks one up before its blockers are linked. A task's issue made before a crash is found by its marker, not made twice. It runs only on the run's way out.",
    inputKinds: {
      issue: "IssueNumber: the spec",
      plan: "the plan as posted, from plan.propose",
      approved: "PlanApproved: from plan.awaitAnswer",
    },
    outputKinds: { created: "each task's key and issue: for plan.becomeEpic" },
    outcomeKinds: {},
    before: ["plan.becomeEpic"],
    last: true,
    inputs: { issue: "required", plan: "required", approved: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly plan: Plan.Plan;
      readonly approved: PlanApproved;
    }) => Plan.create(input.issue, input.plan).pipe(Effect.map((created) => ({ created }))),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "plan.becomeEpic": defineBlock({
    name: "plan.becomeEpic",
    suits: ON_SPEC,
    about:
      "Labels the spec auto:epic, which the epic flow picks up, takes the plan's labels and auto:in-progress off it, deletes its branch, and says which issue each task became. It runs only on the run's way out.",
    inputKinds: {
      issue: "IssueNumber: the spec",
      plan: "the plan as posted, from plan.propose",
      created: "the issues, from plan.create",
    },
    outputKinds: "a summary, for `end`'s summary",
    outcomeKinds: {},
    last: true,
    inputs: { issue: "required", plan: "required", created: "required" },
    run: (input: {
      readonly issue: IssueNumber;
      readonly plan: Plan.Plan;
      readonly created: Plan.Created;
    }) => Plan.becomeEpic(input.issue, input.plan, input.created),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    records: [{ item: "issue", phase: PHASES.issue.becameEpic }],
    contributes: {},
  }),

  "plan.doneDrafting": defineBlock({
    name: "plan.doneDrafting",
    suits: ON_SPEC,
    about:
      "Removes the read-only checkout the agent drafted the plan in, before the run ends: as an epic, or with the agent's questions. A failure going to a person removes it too. It runs only on the run's way out, and a failure of its own fails the run.",
    inputKinds: { issue: "IssueNumber: the spec" },
    outputKinds: "nothing",
    outcomeKinds: {},
    closes: ["remove-checkout"],
    last: true,
    inputs: { issue: "required" },
    run: (input: { readonly issue: IssueNumber }) => Plan.doneDrafting(input.issue),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "plan.askClarification": defineBlock({
    name: "plan.askClarification",
    suits: ON_SPEC,
    about:
      "Posts the agent's questions on the spec, labels it auto:needs-clarification, and says to answer them and apply auto:plan again. Its output is the reason to end with: end: needs-human, and the run lets the claim go. It runs only on the run's way out, and a failure of its own fails the run.",
    inputKinds: {
      issue: "IssueNumber: the spec",
      draft: "the agent's answer, from plan.draft's needs-clarification",
    },
    outputKinds: "the reason, for `end: needs-human`",
    outcomeKinds: {},
    last: true,
    inputs: { issue: "required", draft: "required" },
    run: (input: { readonly issue: IssueNumber; readonly draft: Plan.PlanDraft }) =>
      Plan.askForClarification(input.issue, input.draft),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),
};
