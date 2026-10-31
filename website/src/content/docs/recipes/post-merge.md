---
title: post-merge
description: The post-merge recipe, which watches CI on the merge commit of the persona's merged pull request, and files a follow-up issue when it goes red.
---

```bash
chernabog recipes add post-merge
```

Bakes `.chernabog/flows/post-merge.ts`. It renders no prompt and starts no agent session.

Once a pull request merges, nothing else looks at what happens next. When CI on the base branch goes red on the merge commit, a person finds out when the next pull request's CI fails, or when someone happens to notice. The fix is often a small, well-defined task, which is the work [`implement`](/chernabog/recipes/implement/) takes.

**Picks up** a pull request the persona wrote that merged into the flow's base branch (its `base` setting, or else GitHub's default branch) in the last day, whoever merged it, and that no run has watched yet. A pull request merged into another branch, such as a layer of a stack merged into the layer below, isn't watched: its merge commit isn't on the base branch. The work is keyed by the pull request, `merged-<n>`. The trigger checks the persona's own login, and the flow sets `ownWork: true`.

**Runs as** the persona that wrote the pull request. Several merges are watched at once (`concurrency: 4`), since watching is only polling. No agent runs, so there is no usage gate.

**Ends with** the run done, and, when the merge turned CI red, a follow-up issue filed.

## Its steps

1. A comment on the merged pull request saying it's being watched, with a hidden marker (`chernabog-post-merge-watched`). The trigger leaves a pull request with that marker alone, so each is watched once.
2. `watch-limits` — reads the `noCiGrace` and `ciTimeout` settings once, so a run that resumes decides by the same ones.
3. `ci-<n>` — reads CI on the merge commit, `commitCiState(sha, { event: "push" })`, so runs of other events on the same sha don't count, once a minute, durably (`ci-<n>-wait` between reads).
   - No run at all within `noCiGrace` (10 minutes by default) is taken as no CI for that push, and the run ends done.
   - Still pending after `ciTimeout` ends the run as `needs-human`.
4. **Green:** done.
5. **Red:** `ci-before-merge` reads CI on the merge commit's first parent, the base branch before the merge. When that was red already, the merge didn't break it: nothing is filed, and the run ends done saying so.
6. `failure-details` — each failed run's link and the tail of its failed jobs' logs (`ciFailureDetails`).
7. `file-follow-up` — files an issue, `CI is red on <base> after #<n> merged`, labelled `auto:eligible` so `implement` takes it. It links the merged pull request, the merge commit and each failed run, holds each run's log tail, and has acceptance criteria for the fix. Its body carries a hidden marker with the merge commit's sha (`chernabog-post-merge`). Before filing, the step looks for an issue with that marker among the ones the persona opened lately, so a run that resumes after a crash finds the issue it filed and doesn't file another.
8. A comment on the merged pull request that links the follow-up.

## Settings

```yaml
flows:
  post-merge:
    settings:
      noCiGrace: 3 minutes   # how long a merge commit may go with no CI run before it's taken as none; default 10 minutes
      ciTimeout: 1 hour      # how long CI may stay pending before a person looks
```

The follow-up's labels are the `labels` setting's `eligible` and `needsHuman`.

## No loops

When the merged pull request closes an issue that is itself a follow-up (its body has the `chernabog-post-merge` marker), a red merge commit means the fix didn't fix it, or broke something else. Instead of another follow-up for `implement`, the issue it files is labelled `auto:needs-human`, with the same details and a line saying why. The issue a pull request closes is the one its body names (`Closes #12`), or its claim branch's, `auto/issue-12`.

## Choices you might change

- **Which merges count.** Every pull request the persona wrote, merged by a person or by an approving [`review`](/chernabog/recipes/review/) on the automated path. To watch only `auto:ship` ones, check the pull request's labels in the trigger.
- **The follow-up's label.** `auto:eligible`, so a reviewer looks before it merges. A repo that wants a red base branch fixed on the automated path can file it with `auto:ship` instead.
- **A base that was already red.** It files nothing, on the reasoning that the merge didn't break it, and the run for the merge that did filed its own. To file regardless, drop the `ci-before-merge` check.

## Known limits

- Only pull requests from the last day, among the 30 most recently updated closed ones, are seen. A merge older than that, or one buried under many closed pull requests, isn't watched.
- The commit before the merge may still be running CI when the merge commit goes red. That reads as not red, so a follow-up is filed.
