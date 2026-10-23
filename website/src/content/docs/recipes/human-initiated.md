---
title: human-initiated
description: The human-initiated recipe, the hybrid path, where a person works on an issue with the agent and chernabog takes it to review.
---

```bash
chernabog recipes add human-initiated
```

Bakes `.chernabog/flows/human-initiated.ts`. Its prompt is the SDK's own unless the repo adds `.chernabog/prompts/human-initiated.md`.

This is [the hybrid path](/chernabog/work/flows/#the-hybrid-path). It runs only when a person names an issue, with `chernabog start <issue>` (or `chernabog run human-initiated --item issue-<n>`), whatever its labels: `Hybrid.trigger` finds nothing, so its scheduled ticks start no runs, and `Hybrid.itemFor` finds the issue named. It needs Claude under a [launcher](/chernabog/agents/launchers/#with-a-person) (`orca`, `tmux` or your own); headless, or another agent, fails the run with the reason. A repo without this flow gets an error from `chernabog start` that links here.

**Ends with** a green pull request labelled `hybrid` and a review requested of one reviewer from the pool. [`review`](/chernabog/recipes/review/), [`address-review`](/chernabog/recipes/address-review/) and [`re-review`](/chernabog/recipes/re-review/) take it from there, and a person merges.

## Its steps

1. `Hybrid.claim` — the issue's branch, `auto/issue-<n>`, labelled `auto:in-progress`, with `auto:eligible` and `auto:ship` removed. A branch an unattended run claimed is left to it. An earlier start's claim is taken over.
2. `prepareWorktree` — as `implement`'s.
3. `Hybrid.workWithPerson` — the session with the person, from the `human-initiated` prompt. It ends when `chernabog open-pr` records the pull request's title, body and summary. If the person closes the session before that, the run fails and keeps the claim.
4. `localGate(worktree, { session })` — with `Hybrid.personSession(issue)`, so a failure's fix goes back to the person's session.
5. `push(…, { withPerson: true })`, `Hybrid.openPullRequest` — labelled `hybrid`, never `auto:ship`. The person watched the change written, so it pushes even if it touches `humanOnlyPaths`; see [Trust](/chernabog/operate/trust/). A change to `.github/workflows/` needs a token with the `workflow` scope.
6. `waitForCi` — red goes back to the person's session, up to `limits.ciRounds`. Its fixes push the same way.
7. `Hybrid.handOff` — posts `reviewTrigger` if set and the session marker, comments on the issue, and asks one reviewer from the pool.

Anything that stops it after the session hands the issue to a person with `auto:needs-human`.

There is one session per repo and issue. `chernabog start` on an issue whose run is in flight brings up that run's session. On an issue whose run failed because the session was closed, it starts a new run that takes over the claim and resumes the same Claude session.
