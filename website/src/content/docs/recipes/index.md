---
title: Recipes
description: Complete flows you choose to bake into a repo's .chernabog/flows/, as code the repo then owns.
---

A recipe is a complete flow: its trigger, its steps in order and its endings, written out from the [SDK's blocks](/chernabog/flows/sdk/). You choose the recipes a repo runs, and each one is baked into `.chernabog/flows/` as a file of its own. From then on the file is the repo's code. Read it, edit it, reorder its steps. A later chernabog doesn't change it.

| Recipe | What it does |
| ------ | ------------ |
| [`implement`](/chernabog/recipes/implement/) | Implements the oldest `auto:eligible` or `auto:ship` issue unattended, and asks a reviewer from the pool once its pull request is green |
| [`review`](/chernabog/recipes/review/) | Reviews a pull request whose review is requested of the persona; an approval merges an `auto:ship` pull request |
| [`re-review`](/chernabog/recipes/re-review/) | Reviews again when asked, in its own review session; approves, or hands the pull request to a person |
| [`address-review`](/chernabog/recipes/address-review/) | Answers a review that requests changes on the persona's own pull request, in the session that wrote it |
| [`human-initiated`](/chernabog/recipes/human-initiated/) | The hybrid path: `chernabog start <issue>` opens a session with a person, then opens the pull request and asks for a review |

The first four are the [review loop](/chernabog/work/flows/): together, they take an issue to a reviewed pull request through GitHub's own review requests.

## Choosing recipes

None is installed unless you choose it. `chernabog init` lists the recipes, each with its description and a link to its page here, and bakes the ones you pick. Piped, it bakes only the ones `--recipes` names:

```bash
chernabog init --recipes implement,review,re-review,address-review
```

Later, in a repo that's already set up:

```bash
chernabog recipes list                      # each recipe, with a check by the ones the repo has
chernabog recipes add human-initiated       # bake one more; with none named, asks which
```

Baking writes the recipe's flow, `.chernabog/flows/<name>.ts`, and the prompts it renders (`.chernabog/prompts/implement.md`, `review.md`) when the repo doesn't have them. It never overwrites a file: a flow already there under the recipe's name is kept and said so. Commit the new files, merge them, and `chernabog trust` the repo. Then `chernabog enroll` chooses which personas run them.

A repo with no flows isn't enrolled: `init` says so, and enrolls it once a recipe or a flow of your own is there.

## Changing a baked recipe

A baked recipe is a flow like any other, so [Writing flows](/chernabog/flows/flows/) and [Composing flows](/chernabog/flows/composing/) apply. Two things to keep in mind:

- **Step names are journal keys.** A run in flight resumes by the names of the steps it finished, such as `claim`, `local-gate-1` or `review-2`. Renaming a step, or passing it a different `id`, makes a resumed run do that step again. Upgrading the SDK never renames them.
- **The trigger is policy too.** Each recipe's trigger is written out in the file: which labels queue an issue, which pull requests a persona reviews, what a person has (`auto:needs-human`). Change it there.
