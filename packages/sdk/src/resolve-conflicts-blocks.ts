// The resolve-conflicts blocks: merging the base into a pull request this
// persona wrote that conflicts with it, never by a rebase, after recording a
// squash- or rebase-merged layer below as already here; checking, pushing,
// saying so and waiting for CI on the merge; and asking an approving reviewer
// again. A run owns the pull request throughout, by its subject, so
// address-review doesn't push to the branch under it.

import {
  activity,
  Agent,
  GitHub,
  type Json,
  NeedsHuman,
  NothingCommitted,
  Repo,
  reportAs,
  Run,
  StepFailed,
  type WorkItem,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BaseBranch,
  BranchName,
  Committed,
  defineBlock,
  defineSource,
  type FailureContext,
  PullRequestNumber,
  Pushed,
  ToPerson,
  type WorktreePath,
} from "./block.ts";
import * as Implement from "./implement.ts";
import { PHASES } from "./phases.ts";
import { renderPrompt } from "./prompt.ts";
import * as PullRequest from "./pull-request.ts";
import * as Review from "./review.ts";
import * as Settings from "./settings.ts";
import * as Stack from "./stack.ts";

// GitHub computes mergeability in the background: `mergeable_state` is
// "dirty" for a conflict, and "unknown" until it has looked, which the next
// tick sees again.
const MergeState = Schema.Struct({ mergeable_state: Schema.String });

// What a work item says of a conflicting pull request.
const ConflictItem = Schema.Struct({
  pullRequest: Schema.Finite,
  headRef: Schema.String,
  baseRef: Schema.String,
});

type ConflictItem = typeof ConflictItem.Type;

const Resolution = Schema.Struct({
  status: Schema.Literals(["resolved", "needs-human"]),
  summary: Schema.String,
});

type Resolution = typeof Resolution.Type;

const resolutionJsonSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["resolved", "needs-human"],
      description: "resolved once the merge is committed; needs-human when a person must decide",
    },
    summary: {
      type: "string",
      description:
        "Which files conflicted and how you resolved each, or what a person must decide and why",
    },
  },
  required: ["status", "summary"],
  additionalProperties: false,
} satisfies Json;

// What the agent is told of the merge: to make it, or that the flow left one
// in progress, with these conflicts, after recording the layer below.
type Merge = Option.Option<{ readonly lower: number; readonly conflicts: ReadonlyArray<string> }>;

const describeMerge = (base: string, merge: Merge) =>
  Option.match(merge, {
    onNone: () => `1. \`git fetch origin ${base}\`, then \`git merge --no-ff origin/${base}\`.`,
    onSome: ({ conflicts, lower }) =>
      [
        `1. The merge is already started, and left in progress for you. #${lower}, the layer below this pull request, was squash- or rebase-merged into \`${base}\`, and Chernabog recorded its commits as already here, so a merge doesn't bring back what \`${base}\` has since moved or deleted of that layer. Resolve and commit the merge in progress; don't abort it, start another, or merge \`${base}\` yourself, which would undo that. Chernabog merges whatever of \`${base}\` is left. These files are in conflict:`,
        "",
        ...conflicts.map((path) => `   - ${path}`),
      ].join("\n"),
  });

// The agent merges the base into the branch and commits the merge, in the
// run's own session: `step` is "resolve", or "resolve-2" for a second merge
// the flow left it.
const resolveStep = (
  conflict: ConflictItem,
  worktree: string,
  sessionId: string,
  merge: Merge,
  step: string,
) =>
  activity(
    step,
    Effect.gen(function* () {
      const repo = yield* Repo;
      const rules = yield* Settings.rules;
      const localGate = yield* Settings.localGate;

      const prompt = yield* renderPrompt("resolve-conflicts", {
        repo: repo.slug,
        pullRequest: conflict.pullRequest,
        branch: conflict.headRef,
        base: conflict.baseRef,
        merge: describeMerge(conflict.baseRef, merge),
        humanOnly: rules.humanOnly,
        notes: rules.notes,
        localGate: localGate.commands,
      });

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId,
        resumePrompt: Option.none(),
        outputSchema: Option.some(resolutionJsonSchema),
        adapter: Option.none(),
      });

      return yield* Schema.decodeUnknownEffect(Resolution)(result.output).pipe(
        Effect.mapError(
          (issue) => new StepFailed({ step, message: `agent answer: ${issue.message}` }),
        ),
      );
    }),
    Resolution,
  );

// Resolves the conflict, after recording a squash- or rebase-merged layer
// below as already here when there is one. That record is a merge the flow
// makes (Stack.syncBase), and the agent resolves what it leaves in progress.
// A conflict in the base before the layer below's commits stops it short:
// once the agent commits that, the flow merges again to finish, and the agent
// resolves what that leaves. With nothing left in conflict, no agent runs.
const resolveWithBelow = (conflict: ConflictItem, worktree: string, sessionId: string) =>
  Effect.gen(function* () {
    const below = yield* activity(
      "merged-below",
      Stack.mergedBelow(worktree, conflict.baseRef),
      Schema.Option(Schema.Finite),
    );

    if (Option.isNone(below)) {
      return yield* resolveStep(conflict, worktree, sessionId, Option.none(), "resolve");
    }

    const lower = below.value;
    const recorded = `Recorded #${lower}, the layer below as \`${conflict.baseRef}\` merged it, as already here.`;
    const summaries: Array<string> = [recorded];

    const round = (id: string, step: string) =>
      Effect.gen(function* () {
        const synced = yield* Stack.syncBase(worktree, { base: conflict.baseRef, lower, id }).pipe(
          Effect.catchTag("NotFound", (gone) =>
            Effect.fail(new StepFailed({ step: "update-from-base", message: gone.message })),
          ),
        );

        if (synced.clean) {
          return { synced, resolution: Option.none<Resolution>() };
        }

        const resolution = yield* resolveStep(
          conflict,
          worktree,
          sessionId,
          Option.some({ lower, conflicts: synced.conflicts }),
          step,
        );

        return { synced, resolution: Option.some(resolution) };
      });

    const rounds = [yield* round("resolve", "resolve")];

    if (
      !rounds[0].synced.reconciled &&
      Option.exists(rounds[0].resolution, (said) => said.status === "resolved")
    ) {
      rounds.push(yield* round("resolve-2", "resolve-2"));
    }

    for (const done of rounds) {
      if (Option.isSome(done.resolution)) {
        if (done.resolution.value.status === "needs-human") {
          return done.resolution.value;
        }

        summaries.push(done.resolution.value.summary);
      }
    }

    if (summaries.length === 1) {
      summaries.push("Nothing else conflicted.");
    }

    return { status: "resolved", summary: summaries.join("\n\n") } satisfies Resolution;
  });

// What conflict.resolve gives: the agent's account, the session it resolved
// the conflict in, which the local gate and CI send failures back to, and
// proof the merge was committed.
export type Resolved = {
  readonly resolution: Resolution;
  readonly summary: string;
  readonly session: Implement.AuthorSession;
  readonly committed: Committed;
};

// The words the recipe hands a pull request to a person in when the agent
// committed no merge.
const committedNoMerge = <A, E, R>(effect: Effect.Effect<A, E | NothingCommitted, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is NothingCommitted => error instanceof NothingCommitted,
      (nothing) =>
        Effect.fail(
          new NeedsHuman({ reason: `the agent committed no merge on ${nothing.branch}` }),
        ),
    ),
  );

export const resolveConflictsBlocks = {
  "conflict.resolve": defineBlock({
    name: "conflict.resolve",
    about:
      "Merges the pull request's base into its branch, never by a rebase, and has an agent resolve the conflicts and commit the merge, in a session of the run's own. On a layer of a stack whose layer below squash- or rebase-merged into the base, it first records that layer's commits as already here (merged-below, update-from-base#resolve), so the merge doesn't bring back what the base has since moved or deleted; the agent resolves what that leaves, and with nothing left no agent runs. A conflict in the base before that layer's commits stops the record short, and once the agent commits it the flow merges again (resolve-2). Its prompt is .chernabog/prompts/resolve-conflicts.md, which `chernabog recipes add resolve-conflicts` bakes.",
    inputKinds: {
      pr: "PullRequestNumber",
      branch: "BranchName: the pull request's, trigger.branch",
      base: "BaseBranch: the pull request's base, the layer below's branch on a layer of a stack, trigger.base",
      worktree: "WorktreePath: from author.worktree",
    },
    outputKinds: {
      resolution: "what the agent said: status and summary",
      summary: "which files conflicted and how each was resolved, for conflict.report",
      session:
        "the session that resolved the conflict, for conflict.localGate and conflict.waitForCi",
      committed: "Committed: proof for conflict.push",
    },
    outcomeKinds: {
      "needs-human":
        "an object: reason, why only a person can settle the conflict, for pr.handToPerson",
    },
    stepNames: ["merged-below", "update-from-base", "resolve"],
    before: ["conflict.localGate", "conflict.push"],
    inputs: { pr: "required", branch: "required", base: "required", worktree: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly branch: BranchName;
      readonly base: BaseBranch;
      readonly worktree: WorktreePath;
    }) =>
      Effect.gen(function* () {
        const run = yield* Run;
        const sessionId = Implement.sessionIdFor(run.runId, "resolve-conflicts");

        const resolution = yield* resolveWithBelow(
          { pullRequest: input.pr, headRef: input.branch, baseRef: input.base },
          input.worktree,
          sessionId,
        );

        return {
          resolution,
          summary: resolution.summary,
          session: { sessionId: Option.some(sessionId), adapter: Option.none<string>() },
          committed: new Committed({}),
        };
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {
      "needs-human": (done: { readonly resolution: Resolution }) =>
        Option.liftPredicate(
          { reason: `the merge conflict needs a person:\n\n${done.resolution.summary}` },
          () => done.resolution.status === "needs-human",
        ),
    },
    mustRoute: ["needs-human"],
    contributes: { settings: { ...Settings.Rules.fields, ...Settings.LocalGate.fields } },
  }),

  "conflict.localGate": defineBlock({
    name: "conflict.localGate",
    about:
      "Runs the repo's local gate on the merge, resuming the session that resolved the conflict to fix a failure, up to localGateRounds. Its steps are local-gate-1#resolve and on.",
    inputKinds: {
      pr: "PullRequestNumber",
      worktree: "WorktreePath: from author.worktree",
      session: "the session that resolved the conflict, from conflict.resolve",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["conflict.push"],
    inputs: { pr: "required", worktree: "required", session: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly worktree: WorktreePath;
      readonly session: Implement.AuthorSession;
    }) =>
      Implement.localGate(input.worktree, {
        id: "resolve",
        session: input.session,
        pullRequest: input.pr,
      }),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.LocalGate.fields },
  }),

  "conflict.push": defineBlock({
    name: "conflict.push",
    about:
      "Pushes the merge to the pull request's branch as push-resolved: a plain push, since a merge only adds commits. It is checked against the pull request's base, the layer below's branch on a layer of a stack, so only the branch's own commits count; one that touches humanOnlyPaths goes to a person.",
    inputKinds: {
      worktree: "WorktreePath: from author.worktree",
      branch: "BranchName: the pull request's, trigger.branch",
      base: "BaseBranch: the pull request's, trigger.base",
      committed: "Committed: from conflict.resolve",
    },
    outputKinds: { pushed: "Pushed: proof for conflict.report and conflict.askApproverAgain" },
    outcomeKinds: {},
    before: ["conflict.report", "conflict.waitForCi", "conflict.askApproverAgain"],
    inputs: { worktree: "required", branch: "required", base: "required", committed: "required" },
    run: (input: {
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: BaseBranch;
      readonly committed: Committed;
    }) =>
      committedNoMerge(
        Implement.push("push-resolved", input.worktree, input.branch, { base: input.base }),
      ).pipe(Effect.as({ pushed: new Pushed({}) })),
    failures: { NeedsHuman: "person", PushRejected: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: { ...Settings.Base.fields, ...Settings.Rules.fields } },
  }),

  "conflict.report": defineBlock({
    name: "conflict.report",
    about:
      "Comments on the pull request that the base was merged in to resolve its conflicts, with which files conflicted and how each was resolved.",
    inputKinds: {
      pr: "PullRequestNumber",
      base: "BaseBranch: the pull request's, trigger.base",
      summary: "how the conflicts were resolved, from conflict.resolve",
      pushed: "Pushed: from conflict.push",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["conflict.waitForCi"],
    inputs: { pr: "required", base: "required", summary: "required", pushed: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly base: BaseBranch;
      readonly summary: string;
      readonly pushed: Pushed;
    }) =>
      PullRequest.comment(
        input.pr,
        `Merged \`${input.base}\` into this branch to resolve its conflicts.\n\n${input.summary}`,
      ),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "conflict.waitForCi": defineBlock({
    name: "conflict.waitForCi",
    about:
      "Waits for CI on the pushed merge, resuming the session that resolved the conflict to fix red, up to ciRounds. Its steps carry #resolve.",
    inputKinds: {
      pr: "PullRequestNumber",
      worktree: "WorktreePath: from author.worktree",
      branch: "BranchName: the pull request's, trigger.branch",
      base: "BaseBranch: the pull request's, trigger.base",
      session: "the session that resolved the conflict, from conflict.resolve",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["conflict.askApproverAgain"],
    inputs: {
      pr: "required",
      worktree: "required",
      branch: "required",
      base: "required",
      session: "required",
    },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: BaseBranch;
      readonly session: Implement.AuthorSession;
    }) =>
      committedNoMerge(
        Implement.waitForCi(
          input.pr,
          input.worktree,
          { ...input.session, branch: input.branch, base: input.base },
          { id: "resolve" },
        ),
      ),
    failures: {
      CiTimedOut: "person",
      NeedsHuman: "person",
      PushRejected: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.Ci.fields },
  }),

  "conflict.askApproverAgain": defineBlock({
    name: "conflict.askApproverAgain",
    about:
      "When the pull request's latest approval or request for changes is an approval, asks that reviewer to review again, since they approved the code before the merge; their re-review merges an auto:ship pull request it approves. With no approval it asks no one. A pull request closed meanwhile skips the run. Its output is a summary, for end's summary.",
    inputKinds: {
      pr: "PullRequestNumber",
      base: "BaseBranch: the pull request's, trigger.base",
      pushed: "Pushed: from conflict.push",
    },
    outputKinds: "a summary, for `end`'s summary",
    outcomeKinds: {},
    stepNames: ["ask-approver-again"],
    inputs: { pr: "required", base: "required", pushed: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly base: BaseBranch;
      readonly pushed: Pushed;
    }) =>
      Review.askApproverAgain(input.pr).pipe(
        Effect.map((approver) =>
          Option.match(approver, {
            onNone: () => `#${input.pr}: merged ${input.base} and resolved its conflicts`,
            onSome: (login) =>
              `#${input.pr}: merged ${input.base}, resolved its conflicts and asked ${login} to review again`,
          }),
        ),
      ),
    failures: {
      NeedsHuman: "person",
      PullRequestClosed: "skip",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    records: [{ item: "pull-request", phase: PHASES.pullRequest.reviewAskedAgain }],
    contributes: {},
  }),
};

const decodeIn =
  <A>(schema: Schema.Codec<A, Json>, step: string) =>
  (json: Json) =>
    Schema.decodeEffect(schema)(json).pipe(
      Effect.mapError((issue) => new StepFailed({ step, message: issue.message })),
    );

export const resolveConflictsSources = {
  // Open pull requests this persona wrote that conflict with their base. A
  // person has one labelled auto:needs-human, and a run of another flow one it
  // owns; both are left alone. The key carries the head, so a conflict that
  // comes back after a later push is new work.
  "pr.conflicting": defineSource("pr.conflicting", "conflict", () => ({
    trigger: Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const labelNames = yield* Settings.labels;
      const items: Array<WorkItem> = [];

      for (const pull of yield* Review.authoredByMe) {
        if (pull.labels.includes(labelNames.needsHuman) || (yield* Review.ownedByARun(pull))) {
          continue;
        }

        const state = yield* github
          .request("GET", `/repos/${repo.slug}/pulls/${pull.number}`, Option.none())
          .pipe(Effect.flatMap(decodeIn(MergeState, "trigger")));

        if (state.mergeable_state !== "dirty") {
          continue;
        }

        items.push({
          key: `pr-${pull.number}-${pull.headSha.slice(0, 7)}`,
          title: pull.title,
          url: pull.url,
          data: { pullRequest: pull.number, headRef: pull.headRef, baseRef: pull.baseRef },
        });
      }

      return items;
    }).pipe(reportAs("trigger")),
    contributes: { ownWork: true },
  })),
};

// A pull request this persona wrote that conflicts with its base. A run owns
// the pull request throughout, so no other run pushes to its branch, and lets
// it go however it ends; one another run owns is skipped. A failure going to
// a person labels the pull request auto:needs-human and comments why.
export const conflictSubject = {
  fields: ["pr", "branch", "base"],
  kinds: { pr: "PullRequestNumber", branch: "BranchName", base: "BaseBranch" },
  failureContext: [],
  read: (item: WorkItem) =>
    Schema.decodeUnknownEffect(ConflictItem)(item.data).pipe(
      Effect.mapError((issue) => new StepFailed({ step: "item", message: issue.message })),
      Effect.map((conflict) => ({
        pr: PullRequestNumber(conflict.pullRequest),
        branch: BranchName(conflict.headRef),
        base: BaseBranch(conflict.baseRef),
      })),
    ),
  scope: <A, E, R>(
    trigger: { readonly pr: PullRequestNumber },
    _options: { readonly claims: boolean },
    body: (context: FailureContext) => Effect.Effect<A, E | ToPerson, R>,
  ) =>
    Effect.suspend(() => body({ pr: Option.some(trigger.pr) })).pipe(
      Effect.catchIf(
        (failure): failure is ToPerson => failure instanceof ToPerson,
        (failure) => PullRequest.handToPerson(trigger.pr, failure.reason),
      ),
      PullRequest.owning(trigger.pr),
    ),
  stillValid: Option.some(Review.stillValid),
};
