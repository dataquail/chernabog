---
title: Composing a flow
description: How the default flows are built from the SDK's steps, and how to change one.
---

The default flows each cover one stage and hand work to each other through GitHub's own review requests: `implement` asks a reviewer from the pool, `review` runs as that persona, `fix` asks it again, and `re-review` resumes its own review. Each flow is a short sequence of SDK steps, so a repo changes a stage by editing its flow: reorder the steps, leave one out, put a step of its own in between, or end differently.

## The `implement` flow

This is the flow `init` scaffolds:

```ts
// .chernabog/flows/implement.ts
import { defineFlow, Implement } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

export default defineFlow({
  trigger: Implement.trigger,
  gate: Implement.gate,
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const queued = yield* Implement.queuedBy(item);
      const { branch } = yield* Implement.claim(issue, queued);
      let pullRequest = Option.none<number>();
      const toPerson = (reason: string) => Implement.handToHuman(issue, reason, pullRequest).pipe(Effect.flatMap(Implement.endForPerson));

      return yield* Effect.gen(function* () {
        const worktree = yield* Implement.prepareWorktree(branch);
        const outcome = yield* Implement.implementWithAgent(issue, worktree);

        if (outcome.status === 'needs-clarification') return yield* Implement.askForClarification(issue, outcome, queued).pipe(Effect.flatMap(Implement.endForPerson));

        return yield* Effect.gen(function* () {
          yield* Implement.localGate(worktree);
          yield* Implement.push('push', worktree, branch);
          const opened = yield* Implement.openPullRequest(issue, outcome, queued);
          pullRequest = Option.some(opened.number);
          yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch });

          return yield* Implement.handOff(issue, opened, outcome);
        }).pipe(Effect.catchTag('NeedsHuman', (needsHuman) => toPerson(needsHuman.reason)));
      }).pipe(
        // Any other failure once the issue is claimed hands it to a person, rather
        // than leaving it claimed with nobody working on it.
        Effect.catchTag('StepFailed', (failed) => toPerson(`${failed.step}: ${failed.message}`)),
      );
    }),
});
```

1. **Trigger and claim.** `Implement.trigger` queues issues labelled `auto:eligible`, then `auto:ship`. `Implement.queuedBy(item)` says which label queued the issue; `claim`, `askForClarification` and `openPullRequest` take it, so the claim removes that label and an `auto:ship` issue's pull request is labelled `auto:ship` too.
2. **Implement, gate, push, open, wait for CI.** Each is one activity, so a resumed run picks up after the last one done.
3. **Hand off.** `handOff` closes out the issue and asks one reviewer from the team's [pool](/chernabog/work/flows/#the-reviewer-pool) to review the pull request. That request is what starts `review`, as the reviewer's persona.
4. **Hand to a person.** A `NeedsHuman` or `StepFailed` anywhere after the claim ends in `handToHuman`, which labels the issue and the pull request `auto:needs-human` and says why.

## A review flow of your own

`review` is `Review.trigger` with `Review.workflow`. A repo that wants every request for changes to go to a person, rather than to `fix`, writes its own workflow from the same steps:

```ts
// .chernabog/flows/review.ts
import { defineFlow, PullRequest, Review } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';

export default defineFlow({
  trigger: Review.trigger,
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const { pullRequest } = yield* Review.pullRequestOf(item);
      const review = yield* Review.round(pullRequest, 1, { role: 'reviewer' });

      if (review.verdict === 'approve') return yield* PullRequest.mergeOrLeave(pullRequest);

      return yield* PullRequest.handToPerson(pullRequest, 'review 1 requested changes');
    }),
});
```

`Review.round` reviews in a fresh session of the reviewer role and posts a real GitHub review. `Review.workflow` also removes the review's checkout, `review-pr-<n>`, once it's done; a workflow of your own removes it with `Review.doneReviewing(pr)` when it's done.

## Endings

The ending is the flow's choice. Each of these leaves the labels the way [the label contract](/chernabog/flows/sdk/#the-label-contract) asks:

- **Merge on the automated path.** `PullRequest.mergeOrLeave(pr)` merges an `auto:ship` pull request with `PullRequest.merge(pr, { method: "squash" })`, and leaves any other one for a person to merge. `merge` merges only when the required checks are green, the latest review approved that very head, no `humanOnlyPaths` are touched, and GitHub allows it; otherwise `mergeOrLeave` labels the pull request `auto:needs-human` with the reason. See [Merging](/chernabog/flows/flows/#merging).
- **Hand to a person.** `PullRequest.handToPerson(pr, reason)` labels the pull request `auto:needs-human` and says why; `Implement.handToHuman` does the same for the issue and its pull request.
- **Ask for a review.** `PullRequest.requestReview(pr)` asks one reviewer from the pool, as `handOff` does.
- **Comment and stop.** `PullRequest.comment(pr, …)` posts and does nothing else.

Keep the merge to `mergeOrLeave`, or to a check with `PullRequest.ships`, so chernabog merges only what carries `auto:ship`.
