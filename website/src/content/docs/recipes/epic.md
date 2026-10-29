---
title: epic
description: The epic recipe, which works through an epic's tasks as pull requests, each stacked on the branch of the task it builds on, and parks between changes to its layers.
---

```bash
chernabog recipes add epic
```

Bakes `.chernabog/flows/epic.ts` and the prompt its tasks are implemented from, `.chernabog/prompts/implement.md`.

The [`plan`](/chernabog/recipes/plan/) recipe leaves an epic in GitHub: sub-issues, and what blocks what. This recipe works through it. One run claims the epic and implements each of its `auto` tasks as [`implement`](/chernabog/recipes/implement/) does, but on the branch of the task it builds on, so a chain of tasks becomes a stack of pull requests before the bottom one merges.

**A stack is only pull requests whose base is the branch of the one below.** The run never rebases or force-pushes, and needs no `gh stack`.

**Picks up** each open issue labelled `auto:epic` with an open sub-issue. The trigger also signals a run parked on an epic when one of its layers changed since the run last wrote its status: a pull request pushed, reviewed, merged or closed, or a task closed or relabelled.

**Ends with** every sub-issue of the epic closed. A task that needs a person is handed to one, and the run carries on with the rest.

## Its steps

1. `claim-epic` — takes the epic's [claim ref](/chernabog/flows/sdk/#claims), `epic-<n>`, or skips the run when another run holds it. `Claims.releasing` lets it go however the run ends; a parked run keeps it. While it's held, [`implement`](/chernabog/recipes/implement/) leaves the epic's tasks to this run.
2. `epic-tasks-<round>` — reads where each sub-issue stands with `Epic.progress`: ready on the base branch, ready stacked on the one task that blocks it (an `auto` task, or one this run started, with an open pull request), held with its reason (`waits on #12, #13`, `waits for #12's stack to merge` past `limits.stackDepth`), in review, a person's, merged or closed. Each held task and its reason go to the run log.
3. `epic-status-<round>` — writes that into one status comment on the epic, edited each round.
4. Each ready task, two at once — the steps of [`implement`](/chernabog/recipes/implement/), each named for the task (`claim#task-12`, `implement#task-12`, `local-gate-1#task-12`, `push#task-12`, `open-pull-request#task-12`, `ci-1-1#task-12`, `hand-off#task-12`), on the task's base, in a session of its own. The pull request says `Closes #<task>` and `Part of #<epic>`, and targets the task's base. Then the next round.
5. With nothing left to start, the run parks until the trigger signals a change (`layer-changed`), or for a day, then reads the epic again.

A task whose agent asks questions gets them on the task, labelled `auto:needs-clarification`. Anything else that stops a task hands that task to a person (`needs-human#task-12`). Either way the run lets the task's claim go (`release-claim#task-12`) and carries on. Labelling the task `auto:eligible` again hands it back to the epic run, which starts it again in its next round as a new attempt, with steps and a session of its own (`implement#task-12-2`). A task the run attempted starts again only after it has read as something other than ready, so one another run holds isn't retried round after round.

Review, changes and conflicts on each layer are the other flows' to do: [`review`](/chernabog/recipes/review/), [`address-review`](/chernabog/recipes/address-review/) (which resumes the task's own session), [`re-review`](/chernabog/recipes/re-review/) and [`resolve-conflicts`](/chernabog/recipes/resolve-conflicts/).

## Settings

```yaml
limits:
  stackDepth: 4   # layers one stack may hold before the next waits for its bottom to merge
```

How many tasks run at once (2) and how long the run parks without a signal (a day) are constants at the top of the flow.

## Known limits

- Only `auto` tasks are implemented; `hybrid` and `human` tasks are a person's, and the status comment says so.
- A layer whose base merged isn't moved onto the base branch yet, and the verify task is a person's.
