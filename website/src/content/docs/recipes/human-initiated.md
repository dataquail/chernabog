---
title: human-initiated
description: The human-initiated recipe, the hybrid path, where a person works on an issue with the agent and chernabog takes it to review.
---

```bash
chernabog recipes add human-initiated
```

Bakes `.chernabog/flows/human-initiated.ts`. Its prompt is the SDK's own unless the repo adds `.chernabog/prompts/human-initiated.md`.

This is [the hybrid path](/chernabog/work/flows/#the-hybrid-path). It runs only when a person names an issue, with `chernabog start <issue>` (or `chernabog run human-initiated --item issue-<n>`), whatever its labels. It's a [manual flow](/chernabog/flows/flows/#manual-flows): it has no trigger, so it has no schedule and the daemon never ticks it, and `Hybrid.itemFor` finds the issue named. `status` shows it as `manual (chernabog start <issue>)`, and giving it a `schedule` is a config error. A repo baked before it lost its trigger still has `trigger: Hybrid.trigger`, which keeps working with a schedule that starts nothing; `chernabog recipes diff` shows the line to remove. It needs Claude under a [launcher](/chernabog/agents/launchers/#with-a-person) (`orca`, `tmux` or your own); headless, or another agent, fails the run with the reason. It declares `start: true`, which makes it the flow `chernabog start` runs; a repo with no flow that declares it, or several, gets an error from `chernabog start` that names them.

**Ends with** a green pull request labelled `hybrid` and a review requested of one reviewer from the pool. [`review`](/chernabog/recipes/review/), [`address-review`](/chernabog/recipes/address-review/) and [`re-review`](/chernabog/recipes/re-review/) take it from there, and a person merges.

## Its steps

1. `Hybrid.claim` — the issue's [claim ref](/chernabog/flows/sdk/#claims), then its branch, `auto/issue-<n>` (or the one an earlier start left), labelled `auto:in-progress`, with `auto:eligible` and `auto:ship` removed. An issue another run holds is left to it; the skip names the run, and `chernabog cancel <run>` lets the claim go, whether that run is in flight or has ended with its claim ref left behind. The claim goes when the run ends, however it ends; the branch and any pull request stay.
2. `prepareWorktree` — as `implement`'s.
3. `Hybrid.workWithPerson` — the session with the person, from the `human-initiated` prompt. When the agent thinks the work is done, it drafts the pull request with `chernabog open-pr --draft` and asks the person, in a Yes/No question, whether to open it. The session ends on their Yes, which a hook acts on, not the agent; on No they keep working. The person can also run `chernabog open-pr` themselves. If the person closes the session before that, the run fails and lets the claim go; the issue stays `auto:in-progress`, and `chernabog start` on it again picks the session back up.
4. `localGate(worktree, { session })` — with `Hybrid.personSession(issue)`, so a failure's fix goes back to the person's session.
5. `push(…, { withPerson: true })`, `Hybrid.openPullRequest` — labelled `hybrid`, never `auto:ship`. The person watched the change written, so it pushes even if it touches `humanOnlyPaths`; see [Trust](/chernabog/operate/trust/). A change to `.github/workflows/` needs a token with the `workflow` scope.
6. `waitForCi` — red goes back to the person's session, up to `ciRounds`. Its fixes push the same way.
7. `Hybrid.handOff` — posts the session marker, comments on the issue, and asks one reviewer from the pool.

Anything that stops it after the session hands the issue to a person with `auto:needs-human`.

There is one session per repo and issue. `chernabog start` on an issue whose run is in flight brings up that run's session. On an issue whose run failed because the session was closed, it starts a new run that takes over the claim and resumes the same Claude session.
