---
title: The default flows
description: implement, review and fix, and the labels they move issues and pull requests through.
---

`init` scaffolds three flows in `.chernabog/flows/`, built from the SDK's `Implement` and `Review` blocks. Edit them freely; see [Writing flows](/chernabog/flows/flows/).

| Flow        | Picks up                         | Ends with                                     |
| ----------- | -------------------------------- | --------------------------------------------- |
| `implement` | the oldest `auto:eligible` issue | a green pull request, `auto:needs-review`      |
| `review`    | `auto:needs-review` pull requests | `auto:approved` or `auto:changes-requested`   |
| `fix`       | an agent's pull request with changes requested | a green push, back to `auto:needs-review` |

## `implement`

Each line is one SDK block, in the order the scaffolded flow calls them.

1. `claim` — labels the issue `auto:in-progress`, and moves it to `inProgressStatus` on a [board](/chernabog/reference/configuration/#repo).
2. `prepareWorktree` — a worktree on `auto/issue-<n>`, with `install` run in it.
3. `implementWithAgent` — the agent implements test first, with `notes` and `humanOnly` in its prompt. It may answer with questions instead: `askForClarification` posts them and labels the issue `auto:needs-clarification`.
4. `localGate` — runs each `localGate` command; on failure sends the agent back, up to `limits.localGateRounds`.
5. `push` — a change touching `humanOnlyPaths` stops here, at `auto:needs-human`.
6. `openPullRequest`, then `waitForCi` — waits up to `limits.ciTimeout`, fixing red up to `limits.ciRounds`.
7. `handOff` — labels `auto:needs-review`, and posts `reviewTrigger` on the pull request if set.

## `review`

Reviews in a read-only checkout, in a fresh session of `flows.review.agent` — so Codex can review what Claude wrote — and posts the review. Within the same run it then waits for the author's push or `limits.staleAfter`, whichever comes first, and reviews again, up to `limits.reviewRounds`. A wait holds no concurrency slot. Once the pull request merges or closes, it removes its worktrees.

## `fix`

The author for pull requests an agent wrote: it resumes the session that implemented the pull request with the review, pushes once CI is green, and hands back for the next review. A person's pull request gets the same reviews; their own push wakes the next one.

## Labels

Labels are the public record people see and the flows trigger on. Rename any of them under [`labels`](/chernabog/reference/configuration/#repo); `chernabog labels` creates or corrects them.

| Label                      | Key                  | Set by             | Means                                                   |
| -------------------------- | -------------------- | ------------------ | ------------------------------------------------------- |
| `auto:eligible`            | `eligible`           | a person           | Queued; `implement` claims the oldest                   |
| `auto:in-progress`         | `inProgress`         | `implement`        | A run owns the issue                                    |
| `auto:needs-review`        | `needsReview`        | `implement`, `fix` | The pull request is open and green                      |
| `auto:changes-requested`   | `changesRequested`   | `review`           | Review posted; waiting for a push                       |
| `auto:approved`            | `approved`           | `review`           | A person merges                                         |
| `auto:needs-human`         | `needsHuman`         | any flow           | A loop cap or rule stopped it; no flow picks it up again |
| `auto:needs-clarification` | `needsClarification` | `implement`        | Questions are on the issue; answer and requeue          |
| `auto:stale`               | `stale`              | `review`           | No push came before `limits.staleAfter`                 |

With a `board`, an issue is queued only when it is labelled **and** its Status is `readyStatus`.
