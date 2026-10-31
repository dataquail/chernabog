---
title: review
description: The review recipe, which reviews a pull request whose review is requested of the persona.
---

```bash
chernabog recipes add review
```

Bakes `.chernabog/flows/review.ts` and its prompt, `.chernabog/prompts/review.md`.

**Picks up** an open pull request whose review is requested of the persona this runs as, which it hasn't reviewed yet, unless another flow's run owns it. Its trigger checks the persona's own login, so it needs no `reviewRequested` setting.

**Runs as** a persona with a seat in the [reviewer pool](/chernabog/work/flows/#the-reviewer-pool): a login under `github:` in machine config that the repo's `reviewers:` list. Run as the implicit account, or as a login outside the pool, it starts nothing, and `chernabog status` shows `NotInReviewerPool` with the fix.

**Ends with** an approval, which merges an `auto:ship` pull request when that's safe, or changes requested, which the author's [`address-review`](/chernabog/recipes/address-review/) answers.

## Its steps

1. `Review.round(pr, 1, { role: "reviewer" })` — reviews the head in a read-only checkout, in a fresh session of the reviewer role: `flows.review.agents`, or the persona's `roles` pick, so a different agent from the one that wrote the code can review it. It posts a real GitHub review, approving or requesting changes, with a marker comment that records the reviewer and its session. GitHub won't let an account approve its own pull request; such a review is posted as a comment.
2. `Review.doneReviewing` — removes the checkout.
3. On an approval, `PullRequest.shipping` reads whether the pull request carries `auto:ship`. If it does, `PullRequest.merge(pr, { method: "squash" })` merges it when that is safe, and otherwise `PullRequest.handToPerson` labels it `auto:needs-human` with the reason. When GitHub refuses the merge because the pull request conflicts with its base (`conflicts-pr-<n>` reads its `mergeable_state`), it is left for [`resolve-conflicts`](/chernabog/recipes/resolve-conflicts/), which merges the base in and asks this reviewer again; any other refusal still goes to a person. Any other pull request, a `hybrid` one included, is left for a person to merge.

A repo that baked `review` before this keeps handing a conflicting approval to a person until it brings the change over: `chernabog recipes diff review` shows it.

A request for changes moves no label. The author's `address-review` picks the pull request up from the review itself. A person answering a review on their own pull request pushes and asks the reviewer again.

## Holding merges on a red base

With `holdMergesOnBrokenBase: true` in `config.yaml`'s `settings:`, an approved `auto:ship` pull request whose base branch's CI is red is held rather than merged or handed to a person. `PullRequest.holdWhileBaseRed` comments on the pull request, with a marker naming the run, and parks the run on a `base-green` signal; its step shows `holding merge: CI failing on main`. The trigger reports `base-green` (`PullRequest.baseTurnedGreen`) once the newest completed push runs on the base are no longer red, and the run looks again and merges with `PullRequest.merge`'s usual checks. The fix for a [`post-merge`](/chernabog/recipes/post-merge/) follow-up is never held. `mergeHoldTimeout` caps the wait; past it, the pull request goes to a person. A repo that baked this recipe before brings the change over with `chernabog recipes update`.
