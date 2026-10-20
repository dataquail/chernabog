---
title: Composing a flow
description: One flow that implements, reviews, answers the review and merges, built top-down from the SDK's steps.
---

The default flows each cover one stage and hand work to each other through labels and ticks: `implement` labels a pull request `auto:needs-review`, `review` picks it up on its next tick, `fix` on the tick after. A repo that wants a whole sequence in one run, for some issues, writes it as one flow instead. Each step can be reordered, left out or swapped, and so can the ending.

This page walks through `ship`: for issues labelled `auto:ship`, one run implements the issue, has a reviewer role review it, answers the review in the session that wrote the code, has the reviewer re-check, and ends by merging or by handing it to a person. Issues without the label keep the default flows.

## Configure the roles

The reviewer runs on another agent than the author, so a model never approves its own work:

```yaml
# .chernabog/config.yaml
flows:
  ship:
    agents: { reviewer: codex }
```

Steps given `{ role: "reviewer" }` run with Codex; the others with the flow's `agent`, or the repo's. See [Agents by role](/chernabog/reference/configuration/#agents-by-role).

## The flow

```ts
// .chernabog/flows/ship.ts
import { defineFlow, Implement, NeedsHuman, PullRequest, Review } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

const SHIP = 'auto:ship';

export default defineFlow({
  trigger: Implement.triggerFor(SHIP),
  gate: Implement.gate,
  concurrency: 1,
  labels: [{ name: SHIP, description: 'Implement, review and merge in one run' }],
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue, { label: SHIP });
      let pullRequest = Option.none<number>();
      const toPerson = (reason: string) => Implement.handToHuman(issue, reason, pullRequest).pipe(Effect.flatMap(Implement.endForPerson));

      return yield* Effect.gen(function* () {
        const worktree = yield* Implement.prepareWorktree(branch);
        const outcome = yield* Implement.implementWithAgent(issue, worktree);

        if (outcome.status === 'needs-clarification') return yield* Implement.askForClarification(issue, outcome, { label: SHIP }).pipe(Effect.flatMap(Implement.endForPerson));

        return yield* Effect.gen(function* () {
          yield* Implement.localGate(worktree);
          yield* Implement.push('push', worktree, branch);
          const opened = yield* Implement.openPullRequest(issue, outcome);
          pullRequest = Option.some(opened.number);
          yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch });
          // This run reviews the pull request itself, so the review flow is not asked to.
          yield* Implement.handOff(issue, opened, outcome, { needsReview: false });

          // While this run works on the pull request, the standalone review and fix flows leave it alone.
          return yield* PullRequest.owning(opened.number)(
            Effect.gen(function* () {
              const review = yield* Review.round(opened.number, 1, { role: 'reviewer' });

              if (review.verdict === 'approve') return yield* PullRequest.merge(opened.number, { method: 'squash' });

              const decision = yield* Implement.considerFindings(opened.number, review, Implement.thisRunsSession);

              if (decision.status === 'decline') {
                yield* PullRequest.comment(opened.number, `Not addressing review 1:\n\n${decision.reasons}`);

                return yield* new NeedsHuman({ reason: 'the author declined review 1' });
              }

              const addressed = yield* Implement.addressFindings(opened.number, review, Implement.thisRunsSession);

              if (addressed.status === 'needs-clarification') return yield* new NeedsHuman({ reason: `the author needs a person to answer review 1: ${addressed.questions ?? addressed.summary}` });

              // The second gate and CI wait in this run need ids of their own.
              yield* Implement.localGate(worktree, { id: 'review-1' });
              yield* Implement.push('push-review-1', worktree, branch);
              yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch }, { id: 'review-1' });

              const recheck = yield* Review.recheck(opened.number, review);

              if (recheck.verdict === 'approve') return yield* PullRequest.merge(opened.number, { method: 'squash' });

              return yield* new NeedsHuman({ reason: 'still changes requested after one fix round' });
            }),
          );
        }).pipe(Effect.catchTag('NeedsHuman', (needsHuman) => toPerson(needsHuman.reason)));
      }).pipe(
        // Any other failure once the issue is claimed hands it to a person, rather
        // than leaving it claimed with nobody working on it.
        Effect.catchTag('StepFailed', (failed) => toPerson(`${failed.step}: ${failed.message}`)),
      );
    }),
});
```

Run `chernabog labels` once to create `auto:ship`, which the flow declares.

## Step by step

1. **Trigger and claim.** `Implement.triggerFor("auto:ship")` queues issues by the flow's own label, and `claim(issue, { label: "auto:ship" })` takes that label off. Issues labelled `auto:eligible` stay with `implement`.
2. **Implement, gate, push, open, wait for CI**, as the default `implement` flow does.
3. **Hand off without asking for review.** `handOff(…, { needsReview: false })` closes out the issue but leaves `auto:needs-review` off, so the `review` flow doesn't start a second review of the same pull request.
4. **Own the pull request.** Everything after runs inside `PullRequest.owning(pr)`. The standalone `review` and `fix` flows leave an owned pull request alone, even if a person labels it. The run lets it go however it ends.
5. **Review.** `Review.round(pr, 1, { role: "reviewer" })` reviews in a fresh Codex session and posts the review. It moves no labels.
6. **Consider.** `Implement.considerFindings` resumes the session that implemented the issue and asks whether to address the review or decline it, with reasons.
7. **Fix.** `Implement.addressFindings` makes the changes in that session. The second `localGate` and `waitForCi` take `{ id: "review-1" }`, so their steps don't collide with the first ones'.
8. **Re-check.** `Review.recheck(pr, review)` resumes the reviewer's session with the change since it reviewed, and posts review 2, saying of each finding whether it was remediated.

## Endings

The ending is the flow's choice. Each of these leaves the labels the way [the label contract](/chernabog/flows/sdk/#the-label-contract) asks:

- **Merge.** `PullRequest.merge(pr, { method: "squash" })` merges only when the required checks are green, the latest review approved that very head, no `humanOnlyPaths` are touched, and GitHub allows it. Otherwise it fails with `NeedsHuman` and the reason, which this flow turns into a handoff. See [Merging](/chernabog/flows/flows/#merging).
- **Hand to a person.** `Implement.handToHuman` labels the issue and the pull request `auto:needs-human` and says why on the issue.
- **Mark approved instead of merging.** Call `Review.labelVerdict(pr, 1, review)` after an approving review 1. The pull request is labelled `auto:approved`, and a person merges it.
- **Comment and stop.** `PullRequest.comment(pr, …)` posts and does nothing else.

To make more than one fix round, loop over steps 6 to 8. Re-check the last re-check, and carry the round number into each step's `id`.
