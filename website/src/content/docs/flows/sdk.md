---
title: SDK services
description: The services @chernabog/sdk provides to flows and Effect steps.
---

`@chernabog/sdk` is on npm for types; at runtime the binary supplies its own copy. Each service is a layer, so a team can replace one with its own implementation, and tests can use fakes.

| Service    | Covers                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| `Repo`     | the repo's merged settings: slug, base branch, labels, limits, gates, notes |
| `Run`      | the run: flow, run id and work item                                         |
| `GitHub`   | queued issues, claims, labels, comments, branches, pull requests, CI state  |
| `Agent`    | starting and resuming agent sessions through an [adapter](/chernabog/agents/adapters/) |
| `Git`      | commits ahead, changed files, pushes                                        |
| `Worktree` | one worktree per branch                                                     |
| `Usage`    | the account check and the [usage gate](/chernabog/agents/usage-gate/)        |
| `RunLog`   | the run's log                                                               |
| `Runs`     | whether a run this machine knows is still going; given to triggers, read with `Effect.serviceOption` |

```bash
cd .chernabog && bun install   # or npm, pnpm: dev dependencies, for the editor
```

## The label contract

Labels are how flows hand work to each other, and how people see where it stands. A flow that composes its own sequence from the building blocks has to leave the labels the way the other flows expect them. Keys are under [`labels`](/chernabog/reference/configuration/#repo); the names here are the defaults.

| Label                      | On    | Means                                     | Set by                                                          | Removed by                                     | Read by |
| -------------------------- | ----- | ----------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | ------- |
| `auto:eligible`            | issue | queued                                    | a person                                                        | `Implement.claim`                              | `Implement.trigger`, which starts `implement` |
| `auto:in-progress`         | issue | a run owns the issue                      | `Implement.claim`                                               | `handOff`, `handToHuman`, `askForClarification` | people |
| `auto:needs-clarification` | issue | questions are on the issue                | `Implement.askForClarification`                                 | a person, on requeue                           | people |
| `auto:needs-review`        | PR    | open and green; waiting for a review      | `Implement.handOff` (unless `{ needsReview: false }`), the `fix` flow, the `review` flow before a re-review | `Review.labelVerdict`, `Review.reviewRound` | `Review.trigger`, which starts `review`, and wakes a waiting review with `pushed` once the head moved |
| `auto:changes-requested`   | PR    | reviewed; waiting for a push              | `Review.labelVerdict`, `Review.reviewRound`                     | the `review` and `fix` flows                   | `Review.fixTrigger`, which starts `fix` on an `auto/` branch whose latest review saw its head; `Review.trigger`, which wakes the review of a person's pull request on their push |
| `auto:approved`            | PR    | a person merges                           | `Review.labelVerdict`, `Review.reviewRound`                     | nobody                                         | `Review.trigger`, which wakes a waiting review with `closed` |
| `auto:needs-human`         | both  | a cap or rule stopped it; a person takes over | `Implement.handToHuman`, the `review` and `fix` flows       | a person                                       | no trigger: no flow picks it up again |
| `auto:stale`               | PR    | no push came before `limits.staleAfter`   | the `review` flow                                               | a person                                       | no trigger |

Most steps only post. The ones above that move labels say so, and a step that has a version without labels, such as `Review.round` beside `Review.reviewRound`, lets a flow review without starting or waking another one.

**What a flow leaves behind at each ending.**

- **The issue** never keeps `auto:in-progress` once its run ends: the run that claimed it is the only thing that removes it. `handOff`, `handToHuman` and `askForClarification` each remove it; a flow that ends another way removes it too.
- **A pull request handed on for review** carries `auto:needs-review`, and the session marker `handOff` posts, so the `fix` flow can resume the session that wrote it.
- **A pull request the run reviewed itself** carries at most one of `auto:approved`, `auto:changes-requested` and `auto:needs-human`, or none. `auto:needs-review` would start the `review` flow on it again, and `auto:changes-requested` on an `auto/` branch, with the latest review at its head, starts the `fix` flow, so leave each only when that is what should happen next.
- **Worktrees** of a pull request are removed by the review run that waits on it, when it closes. A flow that ends with no such run waiting removes them with `Review.cleanUp`, or leaves them for a person.

`chernabog status` lists each flow's work from its trigger, so a label left behind shows up there as work waiting to start.

**Ownership.** A flow that reviews and fixes its own pull request wraps that work in `PullRequest.owning(pr)`. That posts an owner marker on the pull request, and a release marker when the work ends, whether it succeeded or failed. A run waiting on a signal keeps the pull request. While a pull request is owned, `Review.trigger` and `Review.fixTrigger` neither start on it nor wake on its pushes. A run this machine knows has ended no longer owns anything, even without a release. One on another machine owns the pull request until its release marker appears.

**Labels of a flow's own.** A flow keyed by its own label, such as `auto:ship`, declares it in `defineFlow({ labels: [{ name: "auto:ship" }] })`, uses `Implement.triggerFor("auto:ship")`, and claims with `Implement.claim(issue, { label: "auto:ship" })`, which removes that label in place of `auto:eligible`. `chernabog labels` creates declared labels beside the repo's own.

**Steps and replays.** `Review.round(pr, n)` saves its result as `review-<n>`, and `Review.labelVerdict(pr, n, review)` as `label-review-<n>`. `labelVerdict` moves the labels only while that review is the latest on the pull request, so replaying an old round never undoes a later one.
