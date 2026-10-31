---
title: re-review
description: The re-review recipe, which reviews again when asked, resuming its own review session.
---

```bash
chernabog recipes add re-review
```

Bakes `.chernabog/flows/re-review.ts`, and `.chernabog/prompts/review.md` for a first review when it has none of its own to resume.

**Picks up** an open pull request that asks the persona to review it again after it already reviewed it, one run per request. It leaves alone a pull request labelled `auto:needs-human`, so asking again during a dispute doesn't restart the loop; a person removes the label to hand it back.

**Runs as** a persona with a seat in the [reviewer pool](/chernabog/work/flows/#the-reviewer-pool): a login under `github:` in machine config that the repo's `reviewers:` list. Run as the implicit account, or as a login outside the pool, it starts nothing, and `chernabog status` shows `NotInReviewerPool` with the fix.

**Ends with** an approval, which merges an `auto:ship` pull request the way [`review`](/chernabog/recipes/review/) does, or the pull request handed to a person with `auto:needs-human`.

## Its steps

1. `Review.latestOwnReview` — the persona's latest review of the pull request, from its marker. Without one to resume, such as a review posted before markers named their reviewer, it reviews afresh, as `review` does.
2. `reviewRounds` caps the re-reviews of one pull request, 1 by default: past it, `PullRequest.handToPerson` hands the pull request to a person without reviewing.
3. `Review.recheck` — resumes the session of its own review with the change since, and posts its review.
4. `Review.doneReviewing`, then `PullRequest.comment` — lists which findings are remediated and which are still open.
5. An approval merges on the automated path, as `review` does: a merge GitHub refuses because the pull request conflicts with its base is left for [`resolve-conflicts`](/chernabog/recipes/resolve-conflicts/), and any other refusal goes to a person. Changes requested again hand the pull request to a person.

A repo that baked `re-review` before this keeps handing a conflicting approval to a person until it brings the change over: `chernabog recipes diff re-review` shows it.

## Holding merges on a red base

With `holdMergesOnBrokenBase: true` in `config.yaml`'s `settings:`, an approved `auto:ship` pull request whose base branch's CI is red is held rather than merged or handed to a person. `PullRequest.mergeHolding` holds the merge: `PullRequest.holdWhileBaseRed` comments on the pull request, with a marker naming the run, and parks the run on a `base-green` signal; its step shows `holding merge: CI failing on main`. The trigger reports `base-green` (`PullRequest.baseTurnedGreen`) once the newest completed push runs on the base are no longer red, and the run looks again and merges with `PullRequest.merge`'s usual checks. The fix for a [`post-merge`](/chernabog/recipes/post-merge/) follow-up is never held. If the base turns red again between that look and the merge, the merge holds again rather than going to a person. The hold comes before the merge's other checks, so a pull request that would be refused anyway, for red checks on its head or a review that no longer stands, waits out the red base first and goes to a person once the base is green. `mergeHoldTimeout` caps the wait; past it, the pull request goes to a person. A repo that baked this recipe before brings the change over with `chernabog recipes update`.
