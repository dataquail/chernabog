---
title: resolve-conflicts
description: The resolve-conflicts recipe, which merges the base into the persona's own pull request when it conflicts, and asks an approving reviewer to look again.
---

```bash
chernabog recipes add resolve-conflicts
```

Bakes `.chernabog/flows/resolve-conflicts.ts` and its prompt, `.chernabog/prompts/resolve-conflicts.md`.

GitHub runs no CI on a pull request that conflicts with its base, and won't merge it. Without this recipe such a pull request is stuck: a run waiting for its CI waits for checks that never start, up to `ciTimeout`, and an approval of an `auto:ship` pull request can't merge it. It happens whenever several agent pull requests are in flight at once and two of them change the same file, a lockfile most often.

**Picks up** an open pull request the persona wrote whose `mergeable_state` on GitHub is `dirty`, a conflict with its base. It leaves alone a pull request labelled `auto:needs-human` or owned by another flow's run. A state of `unknown`, while GitHub hasn't worked it out yet, is skipped, and the next tick looks again. The work is keyed by the pull request and its head, `pr-<n>-<sha>`, so a conflict that comes back after a later push is new work. The trigger checks the persona's own login, and the flow sets `ownWork: true`.

**Runs as** the persona that wrote the pull request, the one whose `implement` or `address-review` pushed it.

**Ends with** the base merged in, a green push, and the approving reviewer asked again when the pull request was approved, or the pull request handed to a person with `auto:needs-human`.

## Its steps

1. `Review.prepareAuthorWorktree` — the author's worktree on the pull request's branch, brought up to date.
2. `resolve` — the agent, in a session of its own, merges the base in with `git merge --no-ff origin/<base>` (never a rebase, reset, amend or force-push, so the push only adds commits), resolves each conflict keeping both sides' intent, regenerates lockfiles from the base's copy rather than merging them by hand, checks no conflict markers are left, and commits the merge. When the two sides contradict each other in a way only a person can settle, it aborts the merge and answers `needs-human`.
3. `Implement.localGate`, `Implement.push` (`push-resolved`) and `Implement.waitForCi` — runs the local gate, pushes, and waits for CI. Failures go back to the session that resolved the conflict, up to `localGateRounds` and `ciRounds`. Between the push and CI it comments on the pull request with which files conflicted and how each was resolved.
4. `ask-approver-again` — when the pull request's latest decisive review, an approval or a request for changes, is an approval, it asks that reviewer to review again, since they approved the code before the merge. Their [`re-review`](/chernabog/recipes/re-review/) merges an `auto:ship` pull request it approves. With no approval, it asks no one.

A `needs-human` answer, a failed step, nothing committed, a rejected push, or CI that times out or stays red hands the pull request to a person with `auto:needs-human`. A pull request closed meanwhile is skipped.

## With review and re-review

When GitHub refuses to merge an approved `auto:ship` pull request because it conflicts with its base, [`review`](/chernabog/recipes/review/) and [`re-review`](/chernabog/recipes/re-review/) leave it for `resolve-conflicts` instead of handing it to a person. Any other refusal still goes to a person. A repo that baked `review` or `re-review` before this keeps handing conflicting approvals to a person until it brings the change over: `chernabog recipes diff review re-review` shows it.

## Known limits

- It works in the same worktree as the pull request's `implement` run. By the time a pull request conflicts, that run is only polling CI, so the two don't edit the worktree at once, but nothing stops them.
- The re-review it asks for counts against `reviewRounds`, like any other. A pull request that conflicts again after a re-review may be handed to a person when the approver is asked a further time.
