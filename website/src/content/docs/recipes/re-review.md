---
title: re-review
description: The re-review recipe, which reviews again when asked, resuming its own review session.
---

```bash
chernabog recipes add re-review
```

Bakes `.chernabog/flows/re-review.ts`, and `.chernabog/prompts/review.md` for a first review when it has none of its own to resume.

**Picks up** an open pull request that asks the persona to review it again after it already reviewed it, one run per request. It leaves alone a pull request labelled `auto:needs-human`, so asking again during a dispute doesn't restart the loop; a person removes the label to hand it back.

**Ends with** an approval, which merges an `auto:ship` pull request the way [`review`](/chernabog/recipes/review/) does, or the pull request handed to a person with `auto:needs-human`.

## Its steps

1. `Review.latestOwnReview` — the persona's latest review of the pull request, from its marker. Without one to resume, such as a review posted before markers named their reviewer, it reviews afresh, as `review` does.
2. `limits.reviewRounds` caps the re-reviews of one pull request, 1 by default: past it, `PullRequest.handToPerson` hands the pull request to a person without reviewing.
3. `Review.recheck` — resumes the session of its own review with the change since, and posts its review.
4. `Review.doneReviewing`, then `PullRequest.comment` — lists which findings are remediated and which are still open.
5. An approval merges on the automated path. Changes requested again hand the pull request to a person.
