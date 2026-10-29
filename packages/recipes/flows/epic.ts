// Works through an epic: claim an open issue labelled auto:epic, and for each
// of its tasks an agent may take that nothing holds back, implement it as
// implement does, as a pull request on the base branch or stacked on the
// branch of the one task it builds on. Tasks that don't build on each other
// run at once. A stack is only pull requests whose base is the branch of the
// one below: no rebase, no force-push. Between rounds the run keeps one
// status comment on the epic, and parks until a layer's pull request changes;
// each layer's review, changes and conflicts are the review, address-review,
// re-review and resolve-conflicts flows' to do. It ends once every sub-issue
// is closed.
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
  Implement,
  Plan,
  reportAs,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

// Round after round: read where the epic stands, write its status comment,
// start every ready task, and with none left to start, park until a layer
// changes. A task the run attempted starts again only once it has read as
// something other than ready since, as one a person handed back with
// auto:eligible after its questions or a hand-off has; one still ready
// after its attempt, as one another run holds, waits. The counts are rebuilt
// from the rounds' saved results whenever the run resumes.
const workThrough = (epic: number) =>
  Effect.gen(function* () {
    const attempts = new Map<number, number>();
    const handedBack = new Set<number>();

    for (let round = 1; ; round++) {
      const progress = yield* Epic.progress(epic, round);
      yield* Epic.postStatus(epic, round, progress);

      if (Epic.finished(progress)) {
        return `#${epic}: every task is closed`;
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
