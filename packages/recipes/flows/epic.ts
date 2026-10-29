// Works through an epic: claim an open issue labelled auto:epic, and for each
// of its tasks an agent may take that nothing holds back, implement it as
// implement does, as a pull request on the base branch or stacked on the
// branch of the one task it builds on. Tasks that don't build on each other
// run at once. A stack is only pull requests whose base is the branch of the
// one below: no rebase, no force-push. Between rounds the run keeps one
// status comment on the epic, and parks until a layer's pull request changes;
// each layer's review, changes and conflicts are the review, address-review,
// re-review and resolve-conflicts flows' to do. When a layer's head moves, as
// a fix pushed on it does, the run carries the change up its stack: it merges
// each layer's moved base into the layer above, bottom to top. It ends once
// every sub-issue is closed.
//
// Each block is a durable activity from @chernabog/sdk, and a task's carry
// its number (`implement#task-12`), so tasks in one run never share a step.
// Side effects belong inside activities or steps, never in the workflow body,
// which runs again whenever the run resumes.
//
// This file is chernabog's epic recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("claim-epic", "epic-tasks-1") are the keys
// a run in flight resumes by, so renaming one restarts that step.

import {
  activity,
  awaitSignal,
  Claims,
  defineFlow,
  Epic,
  Git,
  GitHub,
  Implement,
  Plan,
  Repo,
  reportAs,
  Run,
  Stack,
  Worktree,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Tasks implemented at once.
const AT_ONCE = 2;

// How long the run parks before it looks at the epic again with no signal,
// for what changes no layer: a person's task closed, say.
const LOOK_AGAIN_AFTER = "1 day";

// The id a task's steps carry on an attempt: `task-12` the first time,
// `task-12-2` once a person has handed it back.
const attemptId = (issue: number, attempt: number) => {
  if (attempt === 1) {
    return `task-${issue}`;
  }

  return `task-${issue}-${attempt}`;
};

// Lets the task's claim go once its attempt ends with a person, as a step of
// the attempt's own, so a later attempt lets it go again.
const releaseTask = (issue: number, id: string) =>
  activity(`release-claim#${id}`, Claims.release(Claims.issue(issue)));

// Implements one ready task as implement does, on its base, with its own
// steps and session. A task that needs a person is handed to one, and lets
// its claim go; the run carries on with the rest either way.
const implementTask = (epic: number, task: Epic.Layer, attempt: number) =>
  Effect.gen(function* () {
    const issue = task.number;
    const id = attemptId(issue, attempt);
    let pullRequest = Option.none<number>();

    const toPerson = (reason: string) =>
      Implement.handToHuman(issue, reason, pullRequest, { id }).pipe(
        Effect.tap(() => releaseTask(issue, id)),
      );

    return yield* Effect.gen(function* () {
      const { base, branch } = yield* Implement.claim(issue, { base: task.base, id });

      const session = yield* Implement.sessionFor({ id });
      const worktree = yield* Implement.prepareWorktree(branch, { id });
      const outcome = yield* Implement.implementWithAgent(issue, worktree, { base, id });

      if (outcome.status === "needs-clarification") {
        return yield* Implement.askForClarification(issue, outcome, { id }).pipe(
          Effect.tap(() => releaseTask(issue, id)),
        );
      }

      return yield* Effect.gen(function* () {
        yield* Implement.localGate(worktree, { id, session });
        yield* Implement.push(`push#${id}`, worktree, branch, { base });

        const opened = yield* Implement.openPullRequest(issue, outcome, {
          base,
          id,
          partOf: epic,
        });

        pullRequest = Option.some(opened.number);

        yield* Implement.waitForCi(opened.number, worktree, { ...session, branch, base }, { id });

        return yield* Implement.handOff(issue, opened, outcome, { needsReview: true, id });
      }).pipe(
        Effect.catchTags({
          NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
          NothingCommitted: (nothing) =>
            toPerson(`the agent finished without committing anything on ${nothing.branch}`),
          PushRejected: (rejected) => toPerson(rejected.message),
          CiTimedOut: (timedOut) => toPerson(timedOut.message),
          PullRequestClosed: (closed) => toPerson(closed.message),
        }),
      );
    }).pipe(
      Effect.catchTags({
        // Another run holds the task: it is that run's.
        Skip: (skipped) => Effect.succeed(skipped.reason),
        // A task deleted or transferred under the run leaves nothing to do.
        NotFound: (gone) => Effect.succeed(gone.message),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
      }),
    );
  });

// What the run reads of a stacked layer before it carries the layers below up
// to it, as the step `stack-base-<round>#<pull request>`: the branch it is
// built on and that branch's head, none once it is gone, and whether a person
// has the layer. The saved head is the layer's recorded base, so a replay
// compares as the run first did.
const StackBase = Schema.Struct({
  base: Schema.String,
  baseSha: Schema.Option(Schema.String),
  withPerson: Schema.Boolean,
});

const readBase = (round: number, pullRequest: number) =>
  activity(
    `stack-base-${round}#${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const pull = yield* github.pullRequest(pullRequest);

      return {
        base: pull.baseRef,
        baseSha: yield* github.branchSha(pull.baseRef),
        withPerson: pull.labels.includes(repo.labels.needsHuman),
      };
    }).pipe(
      // A pull request gone under the run leaves nothing to bring up to date.
      Effect.catchTag("NotFound", () =>
        Effect.succeed({ base: "", baseSha: Option.none<string>(), withPerson: false }),
      ),
    ),
    StackBase,
  );

// The run's worktree on the layer's branch, brought up to its remote, as the
// step `prepare-worktree#refresh-<key>`.
const refreshWorktree = (branch: string, key: string) =>
  activity(
    `prepare-worktree#refresh-${key}`,
    Effect.gen(function* () {
      const run = yield* Run;
      const path = yield* (yield* Worktree).ensure(branch, run.runId);
      yield* (yield* Git).pull(path, branch);

      return path;
    }),
    Schema.String,
  );

// Hands a layer whose refresh needs a person to one: labelled auto:needs-human,
// with the reason. Keyed by the refresh, so a later one goes to a person too.
const refreshToPerson = (pullRequest: number, key: string, reason: string) =>
  activity(
    `needs-human#refresh-${key}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      yield* github.addLabel(pullRequest, repo.labels.needsHuman);
      yield* github.comment(
        pullRequest,
        `Chernabog stopped bringing this layer up to date with its base and needs a person: ${reason}`,
      );
    }),
  ).pipe(Effect.as(`#${pullRequest}: ${reason}`));

// A refresh that went to a person: the layer isn't carried.
const toPersonFor = (pullRequest: number, baseSha: string, reason: string) =>
  refreshToPerson(pullRequest, `${pullRequest}-${baseSha.slice(0, 12)}`, reason).pipe(
    Effect.as({ carried: false, pushed: false }),
  );

// Brings one layer up to date with its base at `baseSha` (Stack.refreshLayer):
// merges it in, adjusts the layer when the base changed what it builds on,
// pushes and waits for CI. Whether it pushed; one that needs a person is
// handed to one, and reads as not carried, so the layers above it wait.
const refresh = (layer: Epic.Layer, pullRequest: number, base: string, baseSha: string) =>
  Effect.gen(function* () {
    const branch = Claims.branchFor(layer.number);
    const key = `${pullRequest}-${baseSha.slice(0, 12)}`;
    const worktree = yield* refreshWorktree(branch, key);
    const refreshed = yield* Stack.refreshLayer(worktree, { pullRequest, branch, base, baseSha });

    return { carried: true, pushed: !refreshed.upToDate };
  }).pipe(
    Effect.catchTags({
      NeedsHuman: (needsHuman) => toPersonFor(pullRequest, baseSha, needsHuman.reason),
      StepFailed: (failed) =>
        toPersonFor(pullRequest, baseSha, `${failed.step}: ${failed.message}`),
      NothingCommitted: (nothing) =>
        toPersonFor(pullRequest, baseSha, `nothing to push on ${nothing.branch}`),
      PushRejected: (rejected) => toPersonFor(pullRequest, baseSha, rejected.message),
      CiTimedOut: (timedOut) => toPersonFor(pullRequest, baseSha, timedOut.message),
      // A layer closed or gone under the run has nothing above it to carry.
      PullRequestClosed: () => Effect.succeed({ carried: false, pushed: false }),
      NotFound: () => Effect.succeed({ carried: false, pushed: false }),
    }),
  );

// The epic's layers in review on the branch of another in review, bottom to
// top: each after the one it is stacked on.
const stackedLayers = (progress: Epic.Progress) => {
  const inReview = new Map(
    progress.layers
      .filter(
        (layer) =>
          layer.state === "in-review" && Option.isSome(Option.fromUndefinedOr(layer.pullRequest)),
      )
      .map((layer) => [layer.number, layer]),
  );

  const depthOf = (layer: Epic.Layer) => {
    let depth = 0;
    let below = Option.fromUndefinedOr(layer.stackedOn);

    while (Option.isSome(below) && inReview.has(below.value) && depth < inReview.size) {
      depth += 1;
      below = Option.fromUndefinedOr(inReview.get(below.value)?.stackedOn);
    }

    return depth;
  };

  return [...inReview.values()]
    .filter((layer) => depthOf(layer) > 0)
    .toSorted((left, right) => depthOf(left) - depthOf(right));
};

// Carries each layer's change up its stack, bottom to top: a layer whose base
// branch's head is not the one it was last brought up to is refreshed, then
// the one above it reads its own base, now moved too. A layer a person has,
// or whose refresh went to one, waits, and so do the layers above it; the
// rest of the epic carries on. `recorded` is each layer's base head, by pull
// request, as the run last brought it up to. Whether anything was pushed.
const carryUp = (round: number, progress: Epic.Progress, recorded: Map<number, string>) =>
  Effect.gen(function* () {
    const waiting = new Set<number>();
    let pushed = false;

    for (const layer of stackedLayers(progress)) {
      const pullRequest = layer.pullRequest ?? 0;

      if (Option.exists(Option.fromUndefinedOr(layer.stackedOn), (below) => waiting.has(below))) {
        waiting.add(layer.number);
        continue;
      }

      const read = yield* readBase(round, pullRequest);

      if (read.withPerson || Option.isNone(read.baseSha)) {
        waiting.add(layer.number);
        continue;
      }

      const baseSha = read.baseSha.value;

      if (recorded.get(pullRequest) === baseSha) {
        continue;
      }

      const refreshed = yield* refresh(layer, pullRequest, read.base, baseSha);

      if (!refreshed.carried) {
        waiting.add(layer.number);
        continue;
      }

      recorded.set(pullRequest, baseSha);
      pushed = pushed || refreshed.pushed;
    }

    return pushed;
  });

// Round after round: read where the epic stands, write its status comment,
// carry each moved layer's change up its stack, start every ready task, and
// with none left to start, park until a layer changes. A task the run
// attempted starts again only once it has read as something other than ready
// since, as one a person handed back with auto:eligible after its questions
// or a hand-off has; one still ready after its attempt, as one another run
// holds, waits. The counts are rebuilt from the rounds' saved results
// whenever the run resumes.
const workThrough = (epic: number) =>
  Effect.gen(function* () {
    const attempts = new Map<number, number>();
    const handedBack = new Set<number>();
    const bases = new Map<number, string>();

    for (let round = 1; ; round++) {
      const progress = yield* Epic.progress(epic, round);
      yield* Epic.postStatus(epic, round, progress);

      if (Epic.finished(progress)) {
        return `#${epic}: every task is closed`;
      }

      // A refresh moved layers' heads: read the epic again before going on.
      if (yield* carryUp(round, progress, bases)) {
        continue;
      }

      for (const layer of progress.layers) {
        if (attempts.has(layer.number) && layer.state !== "ready") {
          handedBack.add(layer.number);
        }
      }

      const ready = Epic.startable(progress).filter(
        (task) => !attempts.has(task.number) || handedBack.has(task.number),
      );

      if (ready.length > 0) {
        const starts = ready.map((task) => {
          const attempt = (attempts.get(task.number) ?? 0) + 1;
          attempts.set(task.number, attempt);
          handedBack.delete(task.number);

          return { task, attempt };
        });

        yield* Effect.forEach(starts, (start) => implementTask(epic, start.task, start.attempt), {
          concurrency: AT_ONCE,
          discard: true,
        });
        continue;
      }

      yield* awaitSignal([Epic.LAYER_CHANGED], {
        id: `epic-${round}`,
        timeout: LOOK_AGAIN_AFTER,
      });
    }
  });

export default defineFlow({
  trigger: Epic.queued.pipe(reportAs("trigger")),
  gate: Implement.gate,
  concurrency: 1,
  labels: Plan.flowLabels.filter((label) => label.name === Plan.LABELS.epic),
  // An epic closed, or claimed by another run, ends the run as superseded.
  stillValid: Epic.stillValid,
  // Its markers are the SDK's own: claim refs, labels, assignments, branches.
  markers: [],
  workflow: (item) =>
    Effect.gen(function* () {
      const epic = yield* Implement.issueOf(item);
      yield* Epic.claim(epic);

      // However the run ends, its claim on the epic goes, and the engine lets
      // its tasks' claims go too; a run parked between rounds keeps them.
      return yield* workThrough(epic).pipe(Claims.releasing(Claims.epic(epic)));
    }),
});
