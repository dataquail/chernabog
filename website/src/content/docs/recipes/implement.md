---
title: implement
description: The implement recipe, which takes a queued issue to a green pull request and asks a reviewer from the pool.
---

```bash
chernabog recipes add implement
```

Bakes `.chernabog/flows/implement.ts` and its prompt, `.chernabog/prompts/implement.md`.

**Picks up** the oldest open issue labelled `auto:eligible`, then the oldest labelled `auto:ship`, the [automated path](/chernabog/work/flows/#the-automated-path). A follow-up the [`post-merge`](/chernabog/recipes/post-merge/) recipe filed for red CI on the base comes first (`Implement.followUpsFirst`), since other merges may be [held](/chernabog/recipes/review/#holding-merges-on-a-red-base) for it; only the order changes, and the flow's and the machine's concurrency limits still decide how many start. With a [board](/chernabog/reference/configuration/#repo), only issues whose Status is `readyStatus`. The trigger is written out at the top of the file.

**Ends with** a green pull request and a review requested of one reviewer from the [pool](/chernabog/work/flows/#the-reviewer-pool), or the issue handed to a person.

## Its steps

Each line is one SDK block, in the order the recipe calls them.

1. `claim` — takes the issue's [claim ref](/chernabog/flows/sdk/#claims), which only one run can, then creates `auto/issue-<n>`, or takes up a branch of that name nobody claims as the work to go on with. It labels the issue `auto:in-progress`, removes the label that queued it, and moves it to `inProgressStatus` on a [board](/chernabog/reference/configuration/#repo).
2. `prepareWorktree` — a worktree on `auto/issue-<n>`, with `install` run in it.
3. `implementWithAgent` — the agent implements test first, with `notes` and `humanOnly` in its prompt. It may answer with questions instead: `askForClarification` posts them and labels the issue `auto:needs-clarification`.
4. `localGate` — runs each `localGate` command; on failure sends the agent back, up to `localGateRounds`.
5. `push` — a change touching `humanOnlyPaths` stops here, at `auto:needs-human`, and so does a branch with no commits; when the agent left its changes staged or unstaged instead, the reason names the files.
6. `openPullRequest`, then `waitForCi` — an `auto:ship` issue's pull request is labelled `auto:ship`. Waits up to `ciTimeout`, fixing red up to `ciRounds`.
7. `handOff` — asks one reviewer from the pool for a review.

However the run ends, `Claims.releasing` lets the claim go; the branch and any pull request stay. Anything that stops it once the issue is claimed hands the issue, and its pull request if one is open, to a person with `auto:needs-human`.
