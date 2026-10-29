---
title: plan
description: The plan recipe, which turns a spec issue into an epic of sub-issues, linked by what blocks what, once a person approves the agent's plan.
---

```bash
chernabog recipes add plan
```

Bakes `.chernabog/flows/plan.ts` and its prompt, `.chernabog/prompts/plan.md`.

A spec bigger than one pull request has to be split into issues, and the order they land in kept somewhere. GitHub holds that structure itself: sub-issues give an epic its tasks, and issue dependencies (blocked by) give their order. This recipe has the agent propose that split, and a person approve it, then writes it into GitHub. **The agent answers with data, never a flow:** the repo's other flows pick each task up by its labels, and no run stays alive for the epic.

**Picks up** the oldest open issue labelled `auto:plan`. With a [board](/chernabog/reference/configuration/#repo), only issues whose Status is `readyStatus`. The trigger also reports specs whose posted plan a person has answered, which wake the run waiting on it.

**Ends with** the spec labelled `auto:epic`, with a sub-issue for each task, or the spec handed to a person.

## Its steps

1. `claim` — as [`implement`](/chernabog/recipes/implement/)'s does: takes the spec's [claim ref](/chernabog/flows/sdk/#claims), labels the spec `auto:in-progress` and removes `auto:plan`. `Claims.releasing` lets the claim go however the run ends; a run waiting on an answer to its plan keeps it.
2. `draft-plan-<round>` — the agent reads the spec, its trusted comments and the code, in a read-only checkout of the base branch, and answers with its plan: each task's `key`, `title`, `body`, `kind` and the keys it is `blockedBy`. It may answer with questions instead: they go on the spec, labelled `auto:needs-clarification`, and the run ends.
3. The check, in code — keys unique and usable, every `blockedBy` names a task, no cycles, kinds known, and at most `limits.planNodes` tasks. A plan that fails goes back to the agent with what is wrong (`fix-plan-<round>-<attempt>`), up to `limits.planRounds` times, then to a person.
4. `propose-plan-<round>` — adds a last **verify** task, blocked by all the others, whose body is the spec's `## Acceptance criteria` section, and posts the plan on the spec with a Mermaid diagram of what blocks what. Labels the spec `auto:plan-proposed`.
5. The wait — the run parks until a person answers: the label `auto:plan-approved` approves the plan; a comment from an owner, member or collaborator asks for changes, and the agent drafts it again with that comment (`changes-asked-<round>`, then the next round). Nobody answering within 14 days hands the spec to a person.
6. `create-issues` — each task becomes an issue and a sub-issue of the spec, linked to the tasks that block it, and only then labelled, so no flow takes one before its blockers are linked. Each issue carries a marker with its task's key, so a run that resumes after a crash finds the issues it made rather than making them twice.
7. `epic` — labels the spec `auto:epic` and comments which issue each task became.
8. `clean-up-plan-issue-<n>` — removes the plan's read-only checkout. Every other ending removes it too.

Anything that stops it once the spec is claimed hands it to a person with `auto:needs-human`, and releases the claim, so labelling it `auto:plan` again starts over.

## Who takes each task

A task's `kind` decides its labels, and so which flow picks it up:

| Kind | Label | Taken by |
| ---- | ----- | -------- |
| `auto` | `auto:eligible` | [`implement`](/chernabog/recipes/implement/), once nothing blocks it, or the [`epic`](/chernabog/recipes/epic/) run on the epic, stacked on the task it builds on |
| `hybrid` | none | a person, with `chernabog start <issue>` |
| `human` | `auto:needs-human` | a person, for a decision only they may make |

The verify task is `human`: a person checks what merged against the spec once every other task is closed.

[`implement`](/chernabog/recipes/implement/)'s trigger leaves an issue that an open issue still blocks, so a plan's tasks start in its order. A repo that baked `implement` before this claims a blocked task as soon as it is labelled, until it brings that change over: `chernabog recipes diff implement` shows it.

## Settings

```yaml
limits:
  planNodes: 12   # tasks one plan may hold, verify aside
  planRounds: 2   # times the agent may fix a plan that fails its checks
```

## Known limits

- Every plan needs a person's approval.
- Every task is in the spec's repo.
- Replanning an epic whose plan turned out wrong is not here yet: change its sub-issues by hand.
