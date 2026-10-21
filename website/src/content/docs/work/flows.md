---
title: The default flows
description: implement, review, re-review and fix, and how they hand pull requests to each other through GitHub's review requests.
---

`init` scaffolds four flows in `.chernabog/flows/`, built from the SDK's `Implement`, `Review` and `PullRequest` blocks. Edit them freely; see [Writing flows](/chernabog/flows/flows/).

| Flow        | Picks up                                                | Ends with                                     |
| ----------- | ------------------------------------------------------- | --------------------------------------------- |
| `implement` | the oldest `auto:eligible` or `auto:ship` issue         | a green pull request, and a review requested of one reviewer from the pool |
| `review`    | an open pull request whose review is requested of this persona, which it hasn't reviewed | an approval, which merges an `auto:ship` pull request, or changes requested |
| `re-review` | a pull request that asks this persona again after it reviewed | an approval, or `auto:needs-human`     |
| `fix`       | an agent's pull request labelled `auto:changes-requested` | a green push, and the reviewer asked again  |

The flows hand work to each other through GitHub's own review requests and reviews. With [personas](/chernabog/reference/configuration/#github-personas), one machine can be both the author and the reviewer.

## The reviewer pool

`reviewers:` in the team's `.chernabog/config.yaml` names who reviews:

```yaml
reviewers: [alice, data-quail]
```

Once a pull request's CI is green, `implement` asks one of them, at random, to review it, never the pull request's author. The choice is made once, so a resumed run asks the same person. Without a pool, or with only the author in it, the pull request is labelled `auto:needs-review` for a person to review. Every login in `reviewers:` needs write access to the repo, since the reviewer merges on the automated path; [`chernabog doctor`](/chernabog/work/commands/) checks it for each reviewer this machine acts as.

## The automated path

An issue labelled `auto:ship` instead of `auto:eligible` is implemented the same way, and its pull request carries `auto:ship` too. Chernabog merges a pull request only when it carries `auto:ship`: the reviewer that approves it calls `PullRequest.merge`, which merges only when that is safe and otherwise hands it to a person. Any other pull request, including one whose label is missing or misspelt, is left for a person to merge.

## `implement`

Each line is one SDK block, in the order the scaffolded flow calls them.

1. `claim` — labels the issue `auto:in-progress`, removes the label that queued it, and moves it to `inProgressStatus` on a [board](/chernabog/reference/configuration/#repo).
2. `prepareWorktree` — a worktree on `auto/issue-<n>`, with `install` run in it.
3. `implementWithAgent` — the agent implements test first, with `notes` and `humanOnly` in its prompt. It may answer with questions instead: `askForClarification` posts them and labels the issue `auto:needs-clarification`.
4. `localGate` — runs each `localGate` command; on failure sends the agent back, up to `limits.localGateRounds`.
5. `push` — a change touching `humanOnlyPaths` stops here, at `auto:needs-human`.
6. `openPullRequest`, then `waitForCi` — an `auto:ship` issue's pull request is labelled `auto:ship`. Waits up to `limits.ciTimeout`, fixing red up to `limits.ciRounds`.
7. `handOff` — posts `reviewTrigger` on the pull request if set, and asks one reviewer from the pool for a review.

## `review`

Runs as the persona whose review is requested, on an open pull request it hasn't reviewed yet. Its trigger checks the persona's own login, so it needs no `reviewRequested` setting. It reviews in a read-only checkout, in a fresh session of the reviewer role — `flows.review.agents`, or the persona's `roles` pick — so a different agent from the one that wrote the code can review it. It posts a real GitHub review, approving or requesting changes, with a marker comment that records the reviewer and its session. GitHub won't let an account approve its own pull request; such a review is posted as a comment.

- **Approve.** An `auto:ship` pull request is merged with `PullRequest.merge(pr, { method: "squash" })` when that is safe, and otherwise labelled `auto:needs-human` with the reason. Any other pull request is left for a person to merge.
- **Request changes.** The pull request is labelled `auto:changes-requested`, which starts `fix` on an agent's pull request. A person answering a review on their own pull request pushes and asks the reviewer again.

## `re-review`

Runs as a persona asked to review a pull request it has already reviewed. It resumes the session of its own review (`Review.recheck`) with the change since, posts which findings are remediated and which are still open, and posts its review:

- **Approve.** It merges an `auto:ship` pull request, the same way `review` does.
- **Request changes again.** It hands the pull request to a person with `auto:needs-human`.

`limits.reviewRounds` caps the re-reviews of one pull request, 1 by default: past it, `re-review` hands the pull request to a person without reviewing. It never runs on a pull request labelled `auto:needs-human`, so asking again during a dispute doesn't restart the loop; a person removes the label to hand it back.

## `fix`

The author for pull requests an agent wrote: on one labelled `auto:changes-requested` whose latest review saw its head, it resumes the session that implemented it with the review, pushes once CI is green, removes the label, and asks the reviewer who requested the changes to review again, which starts `re-review`. If the review doesn't say who gave it, the pull request is labelled `auto:needs-review` for a person. Until the `address-review` flow answers GitHub's review itself, `fix` finds its work by the label.

## Labels

Labels are the public record people see, and some flows trigger on them. Rename any of them under [`labels`](/chernabog/reference/configuration/#repo); `chernabog labels` creates or corrects them.

| Label                      | Key                  | Set by             | Means                                                   |
| -------------------------- | -------------------- | ------------------ | ------------------------------------------------------- |
| `auto:eligible`            | `eligible`           | a person           | Queued; `implement` claims the oldest                   |
| `auto:ship`                | `ship`               | a person, `implement` | Queued on the automated path; on a pull request, chernabog merges it once approved |
| `auto:in-progress`         | `inProgress`         | `implement`        | A run owns the issue                                    |
| `auto:needs-review`        | `needsReview`        | `implement`, `fix` | Open and green, with no reviewer in the pool; a person reviews |
| `auto:changes-requested`   | `changesRequested`   | `review`           | Changes requested; `fix` answers an agent's pull request |
| `auto:needs-human`         | `needsHuman`         | any flow           | A loop cap or rule stopped it; no flow picks it up again |
| `auto:needs-clarification` | `needsClarification` | `implement`        | Questions are on the issue; answer and requeue          |
| `auto:approved`            | `approved`           | no default flow    | Kept in the label set for flows of your own             |
| `auto:stale`               | `stale`              | no default flow    | Kept in the label set for flows of your own             |

With a `board`, an issue is queued only when it is labelled **and** its Status is `readyStatus`.
