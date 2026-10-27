---
title: SDK services
description: The services @chernabog/sdk provides to flows and Effect steps.
---

`@chernabog/sdk` is on npm for types; at runtime the binary supplies its own copy. Each service is a layer, so a team can replace one with its own implementation, and tests can use fakes.

| Service    | Covers                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| `Repo`     | the repo's merged settings: slug, base branch, reviewer pool, labels, limits, gates, notes |
| `Run`      | the run: flow, run id and work item                                         |
| `GitHub`   | queued issues, claims, labels, comments, branches, pull requests, review requests and reviews, CI state, merges |
| `Agent`    | starting and resuming agent sessions through an [adapter](/chernabog/agents/adapters/); `withPerson` on a request opens the session [in front of a person](/chernabog/agents/launchers/#with-a-person) |
| `Git`      | commits ahead, changed files, pushes                                        |
| `Worktree` | one worktree per branch                                                     |
| `Usage`    | the account check and the [usage gate](/chernabog/agents/usage-gate/)        |
| `ReviewerSeat` | the persona's seat in the reviewer pool, which every block that reviews requires; checked before a flow runs (see [Errors](/chernabog/flows/flows/#errors)) |
| `RunLog`   | the run's log                                                               |
| `Runs`     | whether a run this machine knows is still going; given to triggers, read with `Effect.serviceOption` |

```bash
cd .chernabog && bun install   # or npm, pnpm: dev dependencies, for the editor
```

## The label contract

Labels are how people see where work stands, and how some flows hand it on. Pull requests pass between `implement`, `review`, `address-review` and `re-review` through GitHub's review requests and reviews instead. A flow that composes its own sequence from the building blocks has to leave the labels the way the other flows expect them. Keys are under [`labels`](/chernabog/reference/configuration/#repo); the names here are the defaults.

| Label                      | On    | Means                                     | Set by                                                          | Removed by                                     | Read by |
| -------------------------- | ----- | ----------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | ------- |
| `auto:eligible`            | issue | queued                                    | a person                                                        | `Implement.claim`, `Hybrid.claim`              | `implement`'s trigger |
| `auto:ship`                | both  | queued, or on a pull request: the automated path, which chernabog merges once approved | a person, on the issue; `Implement.openPullRequest`, on its pull request | `Implement.claim` and `Hybrid.claim`, on the issue | `implement`'s trigger; `PullRequest.ships`, which `shipping` and `mergeOrLeave` ask |
| `auto:in-progress`         | issue | a run owns the issue                      | `Implement.claim`, `Hybrid.claim`                               | `handOff`, `handToHuman`, `askForClarification` | people |
| `auto:needs-clarification` | issue | questions are on the issue                | `Implement.askForClarification`                                 | a person, on requeue                           | people |
| `auto:needs-review`        | PR    | open and green, with no reviewer in the pool; a person reviews | `PullRequest.requestReview` (so `Implement.handOff`) | a person | people |
| `hybrid`                   | PR    | a person worked on it with an agent; a person merges | `Hybrid.openPullRequest` | a person | people; no flow reads it |
| `auto:needs-human`         | both  | a cap or rule stopped it; a person takes over | `Implement.handToHuman`, `PullRequest.handToPerson`, `PullRequest.mergeOrLeave`, the `address-review` flow | a person | the `re-review` and `address-review` triggers, which skip it; no flow picks it up again |

`auto:approved`, `auto:stale` and `auto:changes-requested` stay in the label set, and `chernabog labels` creates them, but no recipe sets or reads them.

Most steps only post. The ones above that move labels say so; `Review.round` and `Review.recheck` post a review and move none.

**What a flow leaves behind at each ending.**

- **The issue** never keeps `auto:in-progress` once its run ends: the run that claimed it is the only thing that removes it. `handOff`, `handToHuman` and `askForClarification` each remove it; a flow that ends another way removes it too.
- **A pull request handed on for review** has a review requested of one reviewer from the pool, or `auto:needs-review` without one, and the session marker `handOff` posts, so the `address-review` flow can resume the session that wrote it. A review request starts `review` as that reviewer, and a second one, after it reviewed, starts `re-review`.
- **A pull request the run reviewed itself** carries `auto:needs-human` or no label. A review that requests changes on the current head starts the author's `address-review`, so post one only when that is what should happen next, or hand the pull request to a person.
- **A merge** happens only through `PullRequest.mergeOrLeave`, or behind a check of `PullRequest.ships`, so chernabog merges nothing that doesn't carry `auto:ship`.
- **Worktrees** of a review, `review-pr-<n>`, are removed by `Review.doneReviewing(pr)`, which the `review` and `re-review` recipes call once they're done. A flow of your own that calls `Review.round` removes it the same way.

`chernabog status` lists each flow's work from its trigger, so a label left behind shows up there as work waiting to start.

## Claims

A claim on an issue or a pull request is a ref of its own, `refs/chernabog/claims/<item>` (`issue-12`, `pr-73`), apart from the work branch. It points at a commit with an empty tree, whose message says whose run holds it:

```
chernabog claim

Run: 3f9c…
Persona: alice
Flow: implement
Claimed-At: 2026-10-26T14:00:00.000Z
```

Creating a ref is the one write GitHub refuses to a second writer, so the run that creates it holds the item, and `Claims.holder(item)` reads who that is. It says nothing about the machine: the ref is as public as the repo. A ref outside `refs/heads/` isn't a branch: it isn't in the branch list, and `push` workflows, which run for branches and tags, don't see it.

`Claims.releasing(item)(effect)` deletes the ref when `effect` ends, whatever the ending; a run waiting on a signal keeps it. A flow that never wraps its claim in it, such as a recipe baked before claims were refs, leaves the ref behind when its run ends, and the issue stays held. `chernabog cancel <run>` lets it go: a run in flight is cancelled as ever, with its claim ref; for a run that has already ended, cancel deletes only the claim ref that still names it, and the run keeps its ending. The work branch stays, and so does any pull request, so a branch with no claim on it is work a later run takes up. Labels, the assignee and the claim comment are how a person sees a claim, written after it is won.

Runs of an earlier version held an issue by its branch alone. While they may be in flight, a branch whose latest claim comment names no claim ref is still theirs, and `claim` skips it.

**Ownership.** A flow that reviews and fixes its own pull request wraps that work in `PullRequest.owning(pr)`. That takes the pull request's claim, `pr-<n>`, and posts an owner marker for people to read, and when the work ends, whether it succeeded or failed, lets the claim go and posts a release marker. A run waiting on a signal keeps the pull request, and a pull request another run owns is skipped. While a pull request is owned, `Review.reviewRequests` leaves it out and `Review.ownedByARun` says so, deciding from the claim ref, so the `review`, `re-review` and `address-review` recipes don't start on it. A run this machine knows has ended no longer owns anything, even with its ref still there. One on another machine owns the pull request until its ref goes. A pull request with no claim ref falls back to the owner markers, for runs of an earlier version.

**Labels of a flow's own.** A flow keyed by its own label, such as `auto:docs`, declares it in `defineFlow({ labels: [{ name: "auto:docs" }] })`, uses `Implement.triggerFor("auto:docs")`, and claims with `Implement.claim(issue, yield* Implement.queuedBy(item))`, which removes that label in place of `auto:eligible`. `chernabog labels` creates declared labels beside the repo's own.

**Steps and replays.** `Review.round(pr, n)` saves its result as `review-<n>`, and `Review.recheck` saves its as the next round's. `PullRequest.requestReview(pr)` chooses its reviewer once, at random, inside an activity, so a replay asks the same person.
