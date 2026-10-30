---
title: Composing a flow
description: How the recipes are built from the SDK's steps, and how to change one.
---

The [review loop's recipes](/chernabog/recipes/) each cover one stage and hand work to each other through GitHub's own review requests: `implement` asks a reviewer from the pool, `review` runs as that persona, `address-review` answers a request for changes and asks it again, and `re-review` resumes its own review. Each flow is a short sequence of SDK steps, so a repo changes a stage by editing its flow: reorder the steps, leave one out, put a step of its own in between, or end differently.

## The `implement` flow

This is the `implement` recipe, as `chernabog recipes add implement` bakes it, without its comments:

```ts
// .chernabog/flows/implement.ts
import { Claims, defineFlow, GitHub, Implement, reportAs, Settings, Skip } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const labels = yield* Settings.labels;
  const eligible = yield* github.queuedIssuesLabelled(labels.eligible);
  const shipping = (yield* github.queuedIssuesLabelled(labels.ship)).filter((issue) => !eligible.some((queued) => queued.number === issue.number));

  return [...eligible.map((issue) => Implement.issueItem(issue)), ...shipping.map((issue) => Implement.issueItem(issue, Option.some(labels.ship)))];
}).pipe(reportAs('trigger'));

// What config.yaml may set for this flow: the SDK's settings its blocks read.
const settings = Schema.Struct({ ...Settings.Labels.fields, ...Settings.Board.fields, ...Settings.LocalGate.fields, ...Settings.Rules.fields, ...Settings.Ci.fields, ...Settings.Reviewers.fields });

export default defineFlow({
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  labels: Effect.map(Settings.declaredLabels, (set) => [...set, ...Implement.adoptionLabels]),
  settings,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const queued = yield* Implement.queuedBy(item);
      let pullRequest = Option.none<number>();
      const toPerson = (reason: string) => Implement.handToHuman(issue, reason, pullRequest).pipe(Effect.flatMap(Implement.endForPerson));

      return yield* Effect.gen(function* () {
        const { branch } = yield* Implement.claim(issue, queued);
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
        }).pipe(
          Effect.catchTags({
            NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
            NothingCommitted: (nothing) => toPerson(`the agent finished without committing anything on ${nothing.branch}`),
            PushRejected: (rejected) => toPerson(rejected.message),
            CiTimedOut: (timedOut) => toPerson(timedOut.message),
            PullRequestClosed: (closed) => toPerson(closed.message),
          }),
        );
      }).pipe(
        Effect.catchTag('StepFailed', (failed) => toPerson(`${failed.step}: ${failed.message}`)),
        Claims.releasing(Claims.issue(issue)),
      );
    }).pipe(Effect.catchTag('NotFound', (gone) => Effect.fail(new Skip({ reason: gone.message })))),
});
```

1. **Trigger and claim.** The trigger queues issues labelled `auto:eligible`, then `auto:ship`, each as `Implement.issueItem(issue, label)`, and `reportAs('trigger')` turns a failed read of GitHub into `StepFailed`. `Implement.queuedBy(item)` says which label queued the issue; `claim`, `askForClarification` and `openPullRequest` take it, so the claim removes that label and an `auto:ship` issue's pull request is labelled `auto:ship` too. `Claims.releasing(Claims.issue(issue))` around the claim and the work lets the [claim](/chernabog/flows/sdk/#claims) go however the run ends.
2. **Implement, gate, push, open, wait for CI.** Each is one activity, so a resumed run picks up after the last one done.
3. **Hand off.** `handOff` closes out the issue and asks one reviewer from the team's [pool](/chernabog/work/flows/#the-reviewer-pool) to review the pull request. That request is what starts `review`, as the reviewer's persona.
4. **Hand to a person.** A `NeedsHuman` or `StepFailed` anywhere after the claim ends in `handToHuman`, which labels the issue and the pull request `auto:needs-human` and says why. So do the [work's errors](/chernabog/flows/flows/#errors) the steps raise: nothing committed, a push the token may not make (whose message says how to fix it), CI that stays pending, or a pull request closed under the run. An issue deleted under the run ends it as skipped. The compiler holds the flow to handling each one.

## A review flow of your own

A repo that wants every request for changes to go to a person, rather than to `address-review`, changes the ending of its baked `review` recipe:

```ts
// .chernabog/flows/review.ts, in its workflow
const review = yield* Review.round(pullRequest, 1, { role: 'reviewer' });
yield* Review.doneReviewing(pullRequest);

if (review.verdict === 'approve') return yield* mergeIfShipping(pullRequest);

return yield* PullRequest.handToPerson(pullRequest, 'review 1 requested changes');
```

`Review.round` reviews in a fresh session of the reviewer role and posts a real GitHub review. It requires the persona's [`ReviewerSeat`](/chernabog/flows/flows/#errors), so the flow does too: run as a persona without a seat in the pool, it stops before its work, and the daemon says why. `Review.doneReviewing(pr)` removes the review's checkout, `review-pr-<n>`, once it's done. `mergeIfShipping` is the recipe's own: it reads `PullRequest.shipping(pr)`, and merges only an `auto:ship` pull request.

## Endings

The ending is the flow's choice. Each of these leaves the labels the way [the label contract](/chernabog/flows/sdk/#the-label-contract) asks:

- **Merge on the automated path.** `PullRequest.mergeOrLeave(pr)` merges an `auto:ship` pull request with `PullRequest.merge(pr, { method: "squash" })`, and leaves any other one for a person to merge. `merge` merges only when the required checks are green, the latest review approved that very head (or one the head has only cleanly merged its base into since), no `humanOnlyPaths` are touched, and GitHub allows it; otherwise it fails with `MergeRefused`, and `mergeOrLeave` labels the pull request `auto:needs-human` with the reason. A layer of a stack waits for the layer below instead: `PullRequest.waitingOnLayer(pr)` says why, and `mergeOrLeave` leaves it approved, for the epic run to merge once it is on the base. A recipe's own `mergeIfShipping` does the same, with `waitingOnLayer` and `Effect.catchTag('MergeRefused', …)`. See [Merging](/chernabog/flows/flows/#merging).
- **Hand to a person.** `PullRequest.handToPerson(pr, reason)` labels the pull request `auto:needs-human` and says why; `Implement.handToHuman` does the same for the issue and its pull request.
- **Ask for a review.** `PullRequest.requestReview(pr)` asks one reviewer from the pool, as `handOff` does.
- **Comment and stop.** `PullRequest.comment(pr, …)` posts and does nothing else.

Keep the merge to `mergeOrLeave`, or to a check with `PullRequest.ships`, so chernabog merges only what carries `auto:ship`.
