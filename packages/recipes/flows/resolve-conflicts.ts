// Unsticks pull requests this persona wrote that conflict with their base
// branch. GitHub runs no CI on a conflicting pull request, so it would wait
// for checks that never start, and it can't merge. An agent merges the base
// into the branch in the author's worktree, resolves the conflicts and commits
// the merge; chernabog runs the local gate, pushes (a plain push: the merge
// only adds commits, so nothing is rewritten) and waits for CI. A run of
// another flow waiting on the pull request's CI, such as implement's, carries
// on from there.
//
// A pull request whose layer below squash- or rebase-merged into its base,
// as one GitHub moved onto the base when the branch below it was deleted,
// would bring back with a plain merge what the base has since moved or
// deleted of that layer (#311). The flow records that layer's commits as
// already here first (Stack.mergedBelow and Stack.syncBase), and the agent
// resolves only what conflicts after that.
//
// A pull request that was already approved goes back to its reviewer, whose
// re-review merges it if it's on the automated path: review and re-review
// leave an approved pull request that can't merge for a conflict to this flow
// rather than to a person. A pull request labelled auto:needs-human is a
// person's and is left alone, as is one that a run of another flow owns. A
// run owns the pull request itself, by its claim ref, so address-review
// doesn't push to the branch while it does, and it waits for an
// address-review run to finish before it starts.
//
// This file is chernabog's resolve-conflicts recipe, and this repo's to
// change: `chernabog recipes diff` shows how it differs from the recipe's
// current version. The names of its steps ("resolve", "push-resolved",
// "ask-approver-again") are the keys a run in flight resumes by, so renaming
// one restarts that step.

import {
  activity,
  Agent,
  defineFlow,
  GitHub,
  Implement,
  type Json,
  NeedsHuman,
  PullRequest,
  renderPrompt,
  Repo,
  reportAs,
  Review,
  Run,
  Settings,
  Skip,
  Stack,
  StepFailed,
  type WorkItem,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// GitHub computes mergeability in the background: `mergeable_state` is
// "dirty" for a conflict, and "unknown" until it has looked, which the next
// tick sees again.
const MergeState = Schema.Struct({ mergeable_state: Schema.String });

const ConflictItem = Schema.Struct({
  pullRequest: Schema.Finite,
  headRef: Schema.String,
  baseRef: Schema.String,
});

type ConflictItem = typeof ConflictItem.Type;

const decodeIn =
  <A>(schema: Schema.Codec<A, Json>, step: string) =>
  (json: Json) =>
    Schema.decodeEffect(schema)(json).pipe(
      Effect.mapError((issue) => new StepFailed({ step, message: issue.message })),
    );

// Open pull requests this persona wrote that conflict with their base. The
// key carries the head, so a conflict that comes back after a later push is
// new work.
const trigger = Effect.gen(function* () {
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
}).pipe(reportAs("trigger"));

const Resolution = Schema.Struct({
  status: Schema.Literals(["resolved", "needs-human"]),
  summary: Schema.String,
});

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

// The agent merges the base into the branch and commits the merge, in its own
// session: `step` is "resolve", or "resolve-2" for a second merge the flow left it.
const resolve = (
  conflict: ConflictItem,
  worktree: string,
  sessionId: string,
  merge: Merge = Option.none(),
  step = "resolve",
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

// When the pull request's latest approval or request for changes is an
// approval, asks its reviewer to review again.
const askApproverAgain = (pullRequest: number) =>
  activity(
    "ask-approver-again",
    Effect.gen(function* () {
      const approval = Option.filter(
        Arr.last(yield* Review.decisiveReviews(pullRequest)),
        (review) => review.state === "APPROVED",
      );

      if (Option.isNone(approval)) {
        return Option.none<string>();
      }

      yield* (yield* GitHub).requestReviewers(pullRequest, [approval.value.author]);

      return Option.some(approval.value.author);
    }),
    Schema.Option(Schema.String),
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
      return yield* resolve(conflict, worktree, sessionId);
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
          return { synced, resolution: Option.none<typeof Resolution.Type>() };
        }

        const resolution = yield* resolve(
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

    return { status: "resolved", summary: summaries.join("\n\n") } satisfies typeof Resolution.Type;
  });

const unstick = (conflict: ConflictItem) =>
  Effect.gen(function* () {
    const run = yield* Run;
    const sessionId = Implement.sessionIdFor(run.runId, "resolve-conflicts");
    // The local gate and CI send failures back to the session that resolved the conflict.
    const session = { sessionId: Option.some(sessionId), adapter: Option.none<string>() };

    const worktree = yield* Review.prepareAuthorWorktree(conflict.headRef);
    const resolution = yield* resolveWithBelow(conflict, worktree, sessionId);

    if (resolution.status === "needs-human") {
      return yield* new NeedsHuman({
        reason: `the merge conflict needs a person:\n\n${resolution.summary}`,
      });
    }

    yield* Implement.localGate(worktree, {
      id: "resolve",
      session,
      pullRequest: conflict.pullRequest,
    });
    // Checked against the pull request's base, the layer below's branch for a layer of a stack.
    yield* Implement.push("push-resolved", worktree, conflict.headRef, { base: conflict.baseRef });
    yield* PullRequest.comment(
      conflict.pullRequest,
      `Merged \`${conflict.baseRef}\` into this branch to resolve its conflicts.\n\n${resolution.summary}`,
    );
    yield* Implement.waitForCi(
      conflict.pullRequest,
      worktree,
      { ...session, branch: conflict.headRef, base: conflict.baseRef },
      { id: "resolve" },
    );

    // An approval was of the code before the merge: its reviewer looks again,
    // and re-review merges an auto:ship pull request it approves.
    const approver = yield* askApproverAgain(conflict.pullRequest);

    return Option.match(approver, {
      onNone: () =>
        `#${conflict.pullRequest}: merged ${conflict.baseRef} and resolved its conflicts`,
      onSome: (login) =>
        `#${conflict.pullRequest}: merged ${conflict.baseRef}, resolved its conflicts and asked ${login} to review again`,
    });
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const conflict = yield* Schema.decodeUnknownEffect(ConflictItem)(item.data).pipe(
      Effect.mapError((issue) => new StepFailed({ step: "item", message: issue.message })),
    );

    const toPerson = (reason: string) => PullRequest.handToPerson(conflict.pullRequest, reason);

    // Anything that stops it hands the pull request to a person, unless it
    // closed meanwhile. It owns the pull request throughout, so no other run
    // pushes to the branch under it; one another run owns is skipped.
    return yield* unstick(conflict).pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
        NothingCommitted: (nothing) =>
          toPerson(`the agent committed no merge on ${nothing.branch}`),
        PushRejected: (rejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut) => toPerson(timedOut.message),
        PullRequestClosed: (closed) => Effect.fail(new Skip({ reason: closed.message })),
      }),
      PullRequest.owning(conflict.pullRequest),
    );
  });

// What config.yaml may set for this flow, under settings: or flows.<name>.settings.
const settings = Schema.Struct({
  ...Settings.Labels.fields,
  ...Settings.Base.fields,
  ...Settings.LocalGate.fields,
  ...Settings.Rules.fields,
  ...Settings.Ci.fields,
});

export default defineFlow({
  labels: Settings.declaredLabels,
  settings,
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  // Its trigger finds only pull requests this persona wrote.
  ownWork: true,
  // A pull request closed or merged ends the run as superseded.
  stillValid: Review.stillValid,
  workflow,
});
