// The hybrid path: `chernabog start <issue>` hands an issue over, and a
// person plans and implements it with Claude in a session in front of them.
// `chernabog open-pr`, run from that session, ends it; then this flow runs the
// local gate, pushes, opens the pull request (labelled hybrid), waits for CI
// and asks a reviewer from the pool. review, address-review and re-review take
// it from there, and a person merges. Nothing starts it on a schedule.
//
// This file is chernabog's human-initiated recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("claim", "work-with-person") are the keys a
// run in flight resumes by, so renaming one restarts that step.

import { defineFlow, Hybrid, Implement, type WorkItem } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const issue = yield* Implement.issueOf(item);
    const { branch } = yield* Hybrid.claim(issue);
    const worktree = yield* Implement.prepareWorktree(branch);
    // A session the person closes before open-pr fails the run and keeps the
    // claim, so chernabog start on the issue again picks the session back up.
    const finished = yield* Hybrid.workWithPerson(issue, worktree);
    let pullRequest = Option.none<number>();
    const toPerson = (reason: string) => Implement.handToHuman(issue, reason, pullRequest).pipe(Effect.flatMap(Implement.endForPerson));

    return yield* Effect.gen(function* () {
      // Fixes for the gate and for red CI go back to the person's session.
      const session = yield* Hybrid.personSession(issue);
      yield* Implement.localGate(worktree, { session });
      yield* Implement.push('push', worktree, branch);
      const opened = yield* Hybrid.openPullRequest(issue, finished);
      pullRequest = Option.some(opened.number);
      yield* Implement.waitForCi(opened.number, worktree, { ...session, branch });

      return yield* Hybrid.handOff(issue, opened, finished);
    }).pipe(
      Effect.catchTag('NeedsHuman', (needsHuman) => toPerson(needsHuman.reason)),
      Effect.catchTag('StepFailed', (failed) => toPerson(`${failed.step}: ${failed.message}`)),
    );
  });

export default defineFlow({
  trigger: Hybrid.trigger,
  item: Hybrid.itemFor,
  // No trigger finds work for several personas to share: each run is a person's.
  ownWork: true,
  workflow,
});
