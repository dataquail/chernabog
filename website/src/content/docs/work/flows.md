---
title: The default flows
description: implement, review, re-review and address-review, and how they hand pull requests to each other through GitHub's review requests.
---

`init` scaffolds four flows in `.chernabog/flows/`, built from the SDK's `Implement`, `Review` and `PullRequest` blocks. Edit them freely; see [Writing flows](/chernabog/flows/flows/).

| Flow        | Picks up                                                | Ends with                                     |
| ----------- | ------------------------------------------------------- | --------------------------------------------- |
| `implement` | the oldest `auto:eligible` or `auto:ship` issue         | a green pull request, and a review requested of one reviewer from the pool |
| `review`    | an open pull request whose review is requested of this persona, which it hasn't reviewed | an approval, which merges an `auto:ship` pull request, or changes requested |
| `re-review` | a pull request that asks this persona again after it reviewed | an approval, or `auto:needs-human`     |
| `address-review` | a pull request this persona wrote whose latest review requests changes, with nothing pushed since | a green push and the reviewer asked again, or `auto:needs-human` |

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
- **Request changes.** No label moves. The author's `address-review` picks the pull request up from the review itself. A person answering a review on their own pull request pushes and asks the reviewer again.

## `re-review`

Runs as a persona asked to review a pull request it has already reviewed. It resumes the session of its own review (`Review.recheck`) with the change since, posts which findings are remediated and which are still open, and posts its review:

- **Approve.** It merges an `auto:ship` pull request, the same way `review` does.
- **Request changes again.** It hands the pull request to a person with `auto:needs-human`.

`limits.reviewRounds` caps the re-reviews of one pull request, 1 by default: past it, `re-review` hands the pull request to a person without reviewing. It never runs on a pull request labelled `auto:needs-human`, so asking again during a dispute doesn't restart the loop; a person removes the label to hand it back.

## `address-review`

Runs as the persona that wrote the pull request: its trigger checks the persona's own login, and the flow sets `ownWork: true`. It picks up an open pull request whose latest decisive review, an approval or a request for changes (comments don't count), requests changes on the current head, so nothing has been pushed since. It leaves alone a pull request labelled `auto:needs-human` or owned by another run. It resumes the session that implemented the pull request, from the session marker `implement` left, and has it consider the findings first (`Implement.considerFindings`):

- **Disagree.** It posts "Not addressing review N:" with its reasons and hands the pull request to a person with `auto:needs-human`. It doesn't push, and doesn't ask the reviewer again.
- **Agree.** `Implement.addressFindings` makes and commits the changes. The flow checks that something was committed, runs the local gate, pushes, and waits for CI, fixing red up to `limits.ciRounds`. Then it comments "Addressed review N:" with what changed and asks the reviewer who requested the changes to review again, which starts their `re-review`.

Anything else that stops it, such as CI still red, a failing local gate, the agent needing an answer, or a failed step, hands the pull request to a person with `auto:needs-human`. A person settles a dispute, removes the label, and asks the reviewer again if it should look again.

## Labels

Labels are the public record people see, and some flows trigger on them. Rename any of them under [`labels`](/chernabog/reference/configuration/#repo); `chernabog labels` creates or corrects them.

| Label                      | Key                  | Set by             | Means                                                   |
| -------------------------- | -------------------- | ------------------ | ------------------------------------------------------- |
| `auto:eligible`            | `eligible`           | a person           | Queued; `implement` claims the oldest                   |
| `auto:ship`                | `ship`               | a person, `implement` | Queued on the automated path; on a pull request, chernabog merges it once approved |
| `auto:in-progress`         | `inProgress`         | `implement`        | A run owns the issue                                    |
| `auto:needs-review`        | `needsReview`        | `implement`        | Open and green, with no reviewer in the pool; a person reviews |
| `auto:needs-human`         | `needsHuman`         | any flow           | A loop cap or rule stopped it; no flow picks it up again |
| `auto:needs-clarification` | `needsClarification` | `implement`        | Questions are on the issue; answer and requeue          |
| `auto:approved`            | `approved`           | no default flow    | Kept in the label set for flows of your own             |
| `auto:stale`               | `stale`              | no default flow    | Kept in the label set for flows of your own             |
| `auto:changes-requested`   | `changesRequested`   | no default flow    | Kept in the label set for flows of your own             |

With a `board`, an issue is queued only when it is labelled **and** its Status is `readyStatus`.
